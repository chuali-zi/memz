'use strict';
const {transaction, checkpoint, getCheckpoint, addCounts} = require('./store');
const {withSyncLock} = require('./sync');
const {ingestCveBatch} = require('./bulk');
const {digest} = require('./normalize');
const gitSource = require('./git-source');
const CHECKPOINT = 'managed:cvelist';
const COMMIT = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;

// Run inside a transaction: this verifies membership, upstream blob identities,
// current pointers and canonical raw JSON hashes in one consistent DB snapshot.
async function verifySnapshot(client, {total, inventoryHash}) {
  const files = (await client.query("SELECT cve_id, path, blob_oid FROM cve.source_files WHERE source='cvelist' ORDER BY path COLLATE \"C\"")).rows;
  if (files.length !== total || gitSource.hashInventory(files.map(row => ({path: row.path, oid: row.blob_oid, cveId: row.cve_id}))) !== inventoryHash) {
    throw new Error('SOURCE_INVENTORY_MISMATCH');
  }
  const {rows: [check]} = await client.query(`SELECT
    (SELECT count(*)::int FROM cve.records WHERE source='cvelist') AS records,
    (SELECT count(*)::int FROM cve.source_files f
      LEFT JOIN cve.records r ON r.source=f.source AND r.source_id=f.cve_id AND r.cve_id=f.cve_id
      LEFT JOIN cve.observations o ON o.id=r.observation_id
      WHERE f.source='cvelist' AND (o.id IS NULL OR o.sha256<>f.sha256 OR r.normalized IS DISTINCT FROM o.normalized)) AS mismatched`);
  if (check.records !== total || check.mismatched !== 0) throw new Error('SOURCE_DATABASE_MISMATCH');
  const states = (await client.query("SELECT normalized->>'state' state,count(*)::int count FROM cve.records WHERE source='cvelist' GROUP BY 1 ORDER BY 1")).rows;
  return {total, inventory_hash: inventoryHash, states, verified: true};
}

function validateCursor(cursor) {
  if (!cursor) return {schema: 1, completed: null, pending: null};
  if (cursor.schema !== 1 || (cursor.completed && (!COMMIT.test(cursor.completed.commit) || !HASH.test(cursor.completed.inventory_hash) || !Number.isSafeInteger(cursor.completed.total)))) throw new Error('INVALID_MANAGED_CHECKPOINT');
  const p = cursor.pending;
  if (p && (!['full', 'incremental'].includes(p.mode) || !COMMIT.test(p.targetCommit) || (p.fromCommit && !COMMIT.test(p.fromCommit)) ||
    !HASH.test(p.inventoryHash) || !Number.isSafeInteger(p.total) || !Number.isSafeInteger(p.selected) ||
    !Number.isSafeInteger(p.nextIndex) || p.nextIndex < 0 || p.nextIndex > p.selected || !p.counts || typeof p.counts !== 'object')) throw new Error('INVALID_MANAGED_CHECKPOINT');
  return cursor;
}

async function syncManaged(pool, {mode = 'incremental', cacheRoot, sourceProvider = gitSource, progress = () => {}, batchSize = 500} = {}) {
  if (!['full', 'incremental'].includes(mode) || !cacheRoot || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error('INVALID_MANAGED_SYNC_OPTIONS');
  let snapshot, resumed = false, actualMode;
  const run = await withSyncLock(pool, 'cvelist', async counts => {
    let cursor = validateCursor(await getCheckpoint(pool, CHECKPOINT));
    resumed = Boolean(cursor.pending);
    const source = await sourceProvider.prepareSource(cacheRoot, {fetch: !resumed, progress});
    const pending = cursor.pending;
    const targetCommit = pending?.targetCommit || source.commit;
    if (!COMMIT.test(targetCommit)) throw new Error('INVALID_SOURCE_COMMIT');
    actualMode = pending?.mode || (!cursor.completed ? 'full' : mode);
    const fromCommit = pending ? pending.fromCommit : actualMode === 'incremental' ? cursor.completed?.commit : null;
    await progress({phase: 'enumerating', commit: targetCommit, resumed});
    if (!fromCommit && cursor.completed) {
      // A full re-scan does not grant permission to accept rewritten history or
      // delete/move records. Validate lineage before selecting every file.
      const lineage = await sourceProvider.enumerateSource(source.repo, targetCommit, {baseCommit: cursor.completed.commit});
      if (lineage.deleted.length) throw new Error('SOURCE_DELETIONS_REQUIRE_REVIEW');
    }
    const inventory = await sourceProvider.enumerateSource(source.repo, targetCommit, {baseCommit: fromCommit || undefined});
    if (inventory.deleted.length) throw new Error('SOURCE_DELETIONS_REQUIRE_REVIEW');
    if (!Number.isSafeInteger(inventory.total) || inventory.total < 1 || !HASH.test(inventory.inventoryHash)) throw new Error('INVALID_SOURCE_INVENTORY');
    if (pending && (pending.inventoryHash !== inventory.inventoryHash || pending.total !== inventory.total || pending.selected !== inventory.entries.length)) throw new Error('SOURCE_RESUME_MISMATCH');
    if (!fromCommit) {
      // A full scan never silently discards records absent from the official tree.
      const ids = new Set(inventory.entries.map(entry => entry.cveId));
      const existing = (await pool.query("SELECT cve_id FROM cve.records WHERE source='cvelist'")).rows;
      if (existing.some(row => !ids.has(row.cve_id))) throw new Error('SOURCE_DELETIONS_REQUIRE_REVIEW');
    }
    if (!pending) {
      cursor = {...cursor, pending: {mode: actualMode, fromCommit: fromCommit || null, targetCommit,
        inventoryHash: inventory.inventoryHash, total: inventory.total, selected: inventory.entries.length,
        nextIndex: 0, counts: {}, startedAt: new Date().toISOString()}};
      await transaction(pool, client => checkpoint(client, CHECKPOINT, cursor));
    }
    await progress({phase: 'importing', commit: targetCommit, total: inventory.total,
      selected: inventory.entries.length, processed: cursor.pending.nextIndex, resumed});
    let batch = [];
    async function flush() {
      if (!batch.length) return;
      const nextIndex = cursor.pending.nextIndex + batch.length;
      const next = {...cursor, pending: {...cursor.pending, nextIndex, counts: {...cursor.pending.counts}}};
      const batchCounts = await transaction(pool, async client => {
        // Administrative bulk writes can flush large GIN pending lists. Keep
        // their budget separate from the 15-second interactive query budget.
        await client.query("SET LOCAL statement_timeout = '120s'");
        const value = await ingestCveBatch(client, batch.map(({entry, raw}) => ({raw,
          sourceURL: `https://github.com/CVEProject/cvelistV5/blob/${targetCommit}/${entry.path}`})));
        // Official date corrections need explicit handling; never claim success
        // while a stale document was skipped by the current-record policy.
        if (value.stale || value.skipped) throw new Error('SOURCE_VERSION_REGRESSION');
        await client.query(`INSERT INTO cve.source_files(source,cve_id,path,blob_oid,sha256)
          SELECT 'cvelist',i.cve_id,i.path,i.blob_oid,i.sha256
          FROM jsonb_to_recordset($1::jsonb) AS i(cve_id text,path text,blob_oid text,sha256 text)
          ON CONFLICT(source,cve_id) DO UPDATE SET path=EXCLUDED.path,blob_oid=EXCLUDED.blob_oid,sha256=EXCLUDED.sha256`,
        [JSON.stringify(batch.map(({entry, raw}) => ({cve_id: entry.cveId, path: entry.path, blob_oid: entry.oid, sha256: digest(raw)})))]);
        addCounts(next.pending.counts, {...value, files: batch.length});
        await checkpoint(client, CHECKPOINT, next);
        return {...value, files: batch.length};
      });
      cursor = next;
      addCounts(counts, batchCounts);
      batch = [];
      await progress({phase: 'importing', commit: targetCommit, total: inventory.total,
        selected: inventory.entries.length, processed: nextIndex, counts: cursor.pending.counts});
    }
    const remaining = inventory.entries.slice(cursor.pending.nextIndex);
    let received = 0;
    for await (const item of sourceProvider.readSourceEntries(source.repo, remaining)) {
      const expected = remaining[received++];
      if (!expected || item.entry.path !== expected.path || item.entry.oid !== expected.oid || item.entry.cveId !== expected.cveId || item.raw?.cveMetadata?.cveId !== expected.cveId) throw new Error('SOURCE_CVE_ID_MISMATCH');
      batch.push(item);
      if (batch.length === batchSize) await flush();
    }
    if (received !== remaining.length) throw new Error('SOURCE_INCOMPLETE_STREAM');
    await flush();
    await progress({phase: 'verifying', commit: targetCommit, total: inventory.total});
    snapshot = await transaction(pool, async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      // Full-library verification is an administrative operation, not a query.
      await client.query("SET LOCAL statement_timeout = '120s'");
      const verified = await verifySnapshot(client, inventory);
      const complete = {...verified, commit: targetCommit, completed_at: new Date().toISOString(),
        counts: cursor.pending.counts};
      await checkpoint(client, CHECKPOINT, {schema: 1, completed: complete, pending: null});
      return complete;
    });
    if (inventory.entries.length === 0) counts.unchanged_snapshot = 1;
    await progress({phase: 'complete', snapshot});
  });
  return {...run, mode: actualMode, resumed, snapshot};
}

async function readSyncStatus(pool) {
  return transaction(pool, async client => {
    const cursor = await getCheckpoint(client, CHECKPOINT);
    // Facets carry current state in the same record transaction. Count complete
    // source-record keys, not CVE IDs (one CVE can have multiple GHSA records).
    // Reading the narrow projection avoids decompressing every normalized JSON.
    const records = (await client.query(`SELECT source,state,count(*)::int count
      FROM (SELECT DISTINCT source,source_id,cve_id,state FROM cve.facets) current_records
      GROUP BY source,state ORDER BY source,state`)).rows;
    const runs = (await client.query('SELECT id,source,started_at,finished_at,status,counts,error_code FROM cve.sync_runs ORDER BY id DESC LIMIT 10')).rows;
    return {schema: 'memz.cve.sync-status.v1', scope: 'CVE Program public records at a pinned commit, including REJECTED; supplemental sources have independent coverage',
      coverage: cursor?.pending ? 'partial_update' : cursor?.completed?.verified ? 'verified_at_last_completed_sync' : 'not_verified',
      completed: cursor?.completed || null, pending: cursor?.pending || null, records, runs,
      guidance: 'Queries read current local records. During pending sync they may span commits. Verification describes the completed sync time; manual imports can change current data. Retry the same sync command to resume interrupted work.'};
  }, {readOnly: true});
}
module.exports = {syncManaged, readSyncStatus, verifySnapshot, CHECKPOINT};
