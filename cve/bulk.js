'use strict';
const {normalize, digest, date} = require('./normalize');

// The caller owns BEGIN/COMMIT, the source sync lock, and its checkpoint. Every
// record lock uses exactly the key used by store.ingest, so manual single-record
// imports and bulk syncs cannot race their source-modified comparisons.
async function ingestCveBatch(client, entries, {fetchedAt} = {}) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 500) throw new Error('INVALID_CVE_BATCH_SIZE');
  const fetched = fetchedAt ? date(fetchedAt) : new Date().toISOString();
  const seen = new Set();
  const input = entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('INVALID_CVE_BATCH_ENTRY');
    const [normalized] = normalize('cvelist', entry.raw);
    const id = normalized.cve_id;
    if (seen.has(id)) throw new Error('DUPLICATE_CVE_BATCH_ID');
    seen.add(id);
    if (entry.sourceURL !== undefined && typeof entry.sourceURL !== 'string') throw new Error('INVALID_CVE_SOURCE_URL');
    return {cve_id:id, source_url:entry.sourceURL || normalized.source_url,
      source_modified:normalized.modified, sha256:digest(entry.raw), raw:entry.raw, normalized};
  });
  const counts = {inserted:0, updated:0, unchanged:0, stale:0, skipped:0};
  // ORDER BY is applied before the volatile lock call. All bulk writers take
  // overlapping keys in the same order, including when input order differs.
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended(lock_key,0))
    FROM (SELECT lock_key FROM unnest($1::text[]) AS keys(lock_key) ORDER BY lock_key COLLATE "C") locks`,
  [input.map(item => `cvelist:${item.cve_id}:${item.cve_id}`)]);
  const current = await client.query(`SELECT r.cve_id,o.sha256,o.source_modified
    FROM cve.records r JOIN cve.observations o ON o.id=r.observation_id
    WHERE r.source='cvelist' AND r.source_id=r.cve_id AND r.cve_id=ANY($1::text[])`, [[...seen]]);
  const previous = new Map(current.rows.map(row => [row.cve_id,row]));
  const changed = [], unchanged = [];
  for (const item of input) {
    const old = previous.get(item.cve_id);
    if (old?.sha256 === item.sha256) { counts.unchanged++; unchanged.push(item.cve_id); }
    else if (old?.source_modified && (!item.source_modified || new Date(item.source_modified) < new Date(old.source_modified))) counts.stale++;
    else { counts[old ? 'updated' : 'inserted']++; changed.push(item); }
  }
  if (changed.length) {
    await client.query(`INSERT INTO cve.observations
      (source,source_id,cve_id,source_url,source_modified,fetched_at,sha256,raw,normalized)
      SELECT 'cvelist',i.cve_id,i.cve_id,i.source_url,i.source_modified,$2::timestamptz,i.sha256,i.raw,i.normalized
      FROM jsonb_to_recordset($1::jsonb) AS i(cve_id text,source_url text,source_modified timestamptz,sha256 text,raw jsonb,normalized jsonb)
      ON CONFLICT (source,source_id,cve_id,sha256) DO NOTHING`, [JSON.stringify(changed), fetched]);
    await client.query(`INSERT INTO cve.records(source,source_id,cve_id,observation_id,normalized,last_seen)
      SELECT 'cvelist',i.cve_id,i.cve_id,o.id,i.normalized,$2::timestamptz
      FROM jsonb_to_recordset($1::jsonb) AS i(cve_id text,sha256 text,normalized jsonb)
      JOIN cve.observations o ON o.source='cvelist' AND o.source_id=i.cve_id AND o.cve_id=i.cve_id AND o.sha256=i.sha256
      ON CONFLICT (source,source_id,cve_id) DO UPDATE SET
        observation_id=EXCLUDED.observation_id,normalized=EXCLUDED.normalized,last_seen=EXCLUDED.last_seen`,
    [JSON.stringify(changed.map(({cve_id,sha256,normalized}) => ({cve_id,sha256,normalized}))), fetched]);
  }
  if (unchanged.length) {
    // Mention only last_seen so unchanged documents do not rebuild facets.
    await client.query(`UPDATE cve.records SET last_seen=GREATEST(last_seen,$2::timestamptz)
      WHERE source='cvelist' AND source_id=cve_id AND cve_id=ANY($1::text[])`, [unchanged, fetched]);
  }
  return counts;
}

module.exports = {ingestCveBatch};
