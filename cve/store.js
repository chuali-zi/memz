'use strict';
const {normalize, unpack, digest, date} = require('./normalize');
async function transaction(pool, fn, {readOnly = false} = {}) {
  const client = await pool.connect();
  try {
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    await client.query("SET LOCAL statement_timeout = '15s'; SET LOCAL lock_timeout = '5s'");
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
async function ingest(client, source, raw, options = {}) {
  const items = normalize(source, raw, options), sha256 = digest(raw), fetched = options.fetchedAt || new Date().toISOString();
  const counts = {inserted: 0, updated: 0, unchanged: 0, stale: 0, skipped: items.length ? 0 : 1};
  if (source === 'ghsa') {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`ghsa:${raw.id}`]);
    const modified = date(raw.modified);
    const previous = (await client.query("SELECT source_modified FROM cve.source_state WHERE source='ghsa' AND source_id=$1", [raw.id])).rows[0];
    if (previous?.source_modified && (!modified || new Date(modified) < previous.source_modified)) return {...counts, stale: 1, skipped: 0};
    // Alias removals detach current links; immutable raw observations stay readable.
    const removed = await client.query("DELETE FROM cve.records WHERE source='ghsa' AND source_id=$1 AND NOT(cve_id=ANY($2::text[]))", [raw.id, items.map(i => i.cve_id)]);
    counts.unlinked = removed.rowCount;
    await client.query(`INSERT INTO cve.source_state(source,source_id,source_modified,sha256,fetched_at) VALUES('ghsa',$1,$2,$3,$4)
      ON CONFLICT(source,source_id) DO UPDATE SET source_modified=EXCLUDED.source_modified,sha256=EXCLUDED.sha256,fetched_at=EXCLUDED.fetched_at`, [raw.id, modified, sha256, fetched]);
  }
  for (const item of items) {
    const key = [source, item.source_id, item.cve_id];
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key.join(':')]);
    const old = (await client.query(`SELECT o.* FROM cve.records r JOIN cve.observations o ON o.id=r.observation_id
      WHERE r.source=$1 AND r.source_id=$2 AND r.cve_id=$3`, key)).rows[0];
    if (old && old.sha256 === sha256) {
      await client.query('UPDATE cve.records SET last_seen=GREATEST(last_seen,$4) WHERE source=$1 AND source_id=$2 AND cve_id=$3', [...key, fetched]);
      counts.unchanged++; continue;
    }
    if (old?.source_modified && (!item.modified || new Date(item.modified) < old.source_modified)) { counts.stale++; continue; }
    const observation = (await client.query(`INSERT INTO cve.observations
      (source,source_id,cve_id,source_url,source_modified,fetched_at,sha256,raw,normalized)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (source,source_id,cve_id,sha256) DO NOTHING RETURNING id`,
    [...key, options.sourceURL || item.source_url, item.modified, fetched, sha256, JSON.stringify(raw), JSON.stringify(item)])).rows[0] ||
      (await client.query('SELECT id FROM cve.observations WHERE source=$1 AND source_id=$2 AND cve_id=$3 AND sha256=$4', [...key, sha256])).rows[0];
    await client.query(`INSERT INTO cve.records(source,source_id,cve_id,observation_id,normalized,last_seen)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(source,source_id,cve_id)
      DO UPDATE SET observation_id=EXCLUDED.observation_id,normalized=EXCLUDED.normalized,last_seen=EXCLUDED.last_seen`,
    [...key, observation.id, JSON.stringify(item), fetched]);
    counts[old ? 'updated' : 'inserted']++;
  }
  return counts;
}
function addCounts(total, counts) { for (const [key, value] of Object.entries(counts)) total[key] = (total[key] || 0) + value; return total; }
async function importDocument(pool, source, raw, options = {}) {
  return transaction(pool, async client => {
    const total = {};
    for (const item of unpack(source, raw)) addCounts(total, await ingest(client, source, item.raw, {...options, catalogDate: item.catalogDate || options.catalogDate}));
    return total;
  });
}
async function checkpoint(client, name, cursor) {
  await client.query(`INSERT INTO cve.checkpoints(name,cursor) VALUES($1,$2) ON CONFLICT(name)
    DO UPDATE SET cursor=EXCLUDED.cursor,updated_at=now()`, [name, JSON.stringify(cursor)]);
}
async function getCheckpoint(pool, name) { return (await pool.query('SELECT cursor FROM cve.checkpoints WHERE name=$1', [name])).rows[0]?.cursor; }
async function runTracked(pool, source, fn) {
  const id = (await pool.query("INSERT INTO cve.sync_runs(source,status) VALUES($1,'running') RETURNING id", [source])).rows[0].id;
  const counts = {};
  try {
    await fn(counts);
    await pool.query("UPDATE cve.sync_runs SET status='complete',finished_at=now(),counts=$2 WHERE id=$1", [id, JSON.stringify(counts)]);
    return {run_id: id, status: 'complete', counts};
  } catch (error) {
    await pool.query("UPDATE cve.sync_runs SET status='failed',finished_at=now(),counts=$2,error_code=$3 WHERE id=$1", [id, JSON.stringify(counts), /^[A-Z][A-Z_0-9]{0,63}$/.test(error.message) ? error.message : 'SYNC_FAILED']).catch(() => {});
    throw error;
  }
}
module.exports = {transaction, ingest, importDocument, checkpoint, getCheckpoint, runTracked, addCounts};
