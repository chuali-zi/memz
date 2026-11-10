'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {temporaryDatabase} = require('./temporary-db');
const {transaction,importDocument,checkpoint,getCheckpoint} = require('../store');
const {ingestCveBatch} = require('../bulk');
const {digest} = require('../normalize');
const fixture = require('./fixtures/cve5.json');
const adminURL = process.env.CVE_TEST_DATABASE_URL;
function entry(id,modified = '2099-01-10T00:00:00Z',product = 'nginx') {
  const raw = structuredClone(fixture);
  raw.cveMetadata.cveId = id;
  raw.cveMetadata.dateUpdated = modified;
  raw.containers.cna.affected = [{vendor:'bulk fixture',product,versions:[{version:'1',status:'affected'}]}];
  return {raw,sourceURL:`https://example.invalid/frozen/${id}.json`};
}
const bulk = (pool,entries,options) => transaction(pool,client => ingestCveBatch(client,entries,options));
const count = async (pool,table) => (await pool.query(`SELECT count(*)::int n FROM cve.${table}`)).rows[0].n;

test('isolated PostgreSQL bulk preserves observations, stale rules, facets and transactions', {skip:!adminURL,timeout:120000}, async t => {
  await temporaryDatabase(adminURL, async pool => {
    const original = entry('CVE-2099-82001');
    let first;
    await t.test('batch insert retains complete raw evidence, source URL and trigger facets', async () => {
      assert.deepEqual(await bulk(pool,[original,entry('CVE-2099-82002')],{fetchedAt:'2099-02-01'}),
        {inserted:2,updated:0,unchanged:0,stale:0,skipped:0});
      first = (await pool.query('SELECT * FROM cve.observations WHERE cve_id=$1',[original.raw.cveMetadata.cveId])).rows[0];
      assert.deepEqual(first.raw,original.raw);
      assert.equal(first.sha256,digest(original.raw));
      assert.equal(first.source_url,original.sourceURL);
      const facets = (await pool.query('SELECT stack,product,state FROM cve.facets WHERE cve_id=$1',[original.raw.cveMetadata.cveId])).rows;
      assert.deepEqual(facets,[{stack:'web',product:'nginx',state:'PUBLISHED'}]);
    });
    await t.test('same hash only advances last_seen and stale versions do not change current evidence', async () => {
      // A projection trigger makes any accidental same-hash facet rewrite fail.
      await pool.query(`CREATE FUNCTION public.reject_bulk_facet_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'unexpected facet rewrite'; END $$;
        CREATE TRIGGER reject_bulk_facet_write BEFORE INSERT OR DELETE ON cve.facets
        FOR EACH ROW EXECUTE FUNCTION public.reject_bulk_facet_write()`);
      try {
        assert.equal((await bulk(pool,[original],{fetchedAt:'2099-02-03'})).unchanged,1);
        assert.equal((await bulk(pool,[original],{fetchedAt:'2099-02-02'})).unchanged,1);
        assert.equal((await bulk(pool,[entry('CVE-2099-82001','2099-01-01T00:00:00Z','mysql')])).stale,1);
        const missing = entry('CVE-2099-82001'); delete missing.raw.cveMetadata.dateUpdated;
        assert.equal((await bulk(pool,[missing])).stale,1);
      } finally {await pool.query('DROP TRIGGER reject_bulk_facet_write ON cve.facets; DROP FUNCTION public.reject_bulk_facet_write()');}
      const row = (await pool.query('SELECT observation_id,last_seen FROM cve.records WHERE cve_id=$1',[original.raw.cveMetadata.cveId])).rows[0];
      assert.equal(row.observation_id,first.id);
      assert.equal(row.last_seen.toISOString(),'2099-02-03T00:00:00.000Z');
      assert.equal(await count(pool,'observations'),2);
    });
    await t.test('equal-timestamp corrections replace facets and old hashes reuse immutable observations', async () => {
      const corrected = entry('CVE-2099-82001',original.raw.cveMetadata.dateUpdated,'mysql');
      corrected.raw.cveMetadata.state = 'REJECTED';
      corrected.raw.containers.cna.rejectedReasons = [{lang:'en',value:'Synthetic correction'}];
      assert.equal((await bulk(pool,[corrected])).updated,1);
      assert.deepEqual((await pool.query('SELECT stack,product,state FROM cve.facets WHERE cve_id=$1',[original.raw.cveMetadata.cveId])).rows,
        [{stack:'sql',product:'mysql',state:'REJECTED'}]);
      assert.equal((await bulk(pool,[original])).updated,1);
      assert.equal(await count(pool,'observations'),3);
      assert.equal((await pool.query('SELECT observation_id FROM cve.records WHERE cve_id=$1',[original.raw.cveMetadata.cveId])).rows[0].observation_id,first.id);
      assert.deepEqual((await pool.query('SELECT raw FROM cve.observations WHERE id=$1',[first.id])).rows[0].raw,original.raw);
    });
    await t.test('duplicates and malformed documents leave the caller transaction unchanged', async () => {
      const before = await count(pool,'observations');
      await assert.rejects(() => bulk(pool,[entry('CVE-2099-83001'),entry('CVE-2099-83001')]),/DUPLICATE_CVE_BATCH_ID/);
      await assert.rejects(() => bulk(pool,[entry('CVE-2099-83001'),{raw:{}}]),/UNSUPPORTED_CVE_FORMAT/);
      assert.equal(await count(pool,'observations'),before);
    });
    await t.test('database failure in a later record rolls back all observations, records, facets and checkpoint', async () => {
      const before = {observations:await count(pool,'observations'),records:await count(pool,'records'),facets:await count(pool,'facets')};
      await pool.query(`CREATE FUNCTION public.reject_bulk_record() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.cve_id='CVE-2099-83002' THEN RAISE EXCEPTION 'synthetic batch failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_bulk_record BEFORE INSERT ON cve.records FOR EACH ROW EXECUTE FUNCTION public.reject_bulk_record()`);
      try {
        await assert.rejects(() => transaction(pool,async client => {
          await checkpoint(client,'bulk-rollback',{next:2});
          await ingestCveBatch(client,[entry('CVE-2099-83001'),entry('CVE-2099-83002')]);
        }),/synthetic batch failure/);
      } finally {await pool.query('DROP TRIGGER reject_bulk_record ON cve.records; DROP FUNCTION public.reject_bulk_record()');}
      assert.equal(await getCheckpoint(pool,'bulk-rollback'),undefined);
      for (const table of Object.keys(before)) assert.equal(await count(pool,table),before[table]);
    });
    await t.test('bulk and original single-record imports share locks and the latest source timestamp wins', async () => {
      // Commit is withheld until the other writer has started. Its SELECT of
      // current evidence must happen after the shared advisory lock is released.
      async function race(firstEntry,secondEntry,firstIsBulk) {
        const client = await pool.connect();
        let pending;
        try {
          await client.query('BEGIN');
          if (firstIsBulk) await ingestCveBatch(client,[firstEntry]);
          else {
            const {ingest} = require('../store');
            await ingest(client,'cvelist',firstEntry.raw,{sourceURL:firstEntry.sourceURL});
          }
          let started;
          const ready = new Promise(resolve => {started=resolve;});
          pending = transaction(pool,async other => {
            const observed = {query:(...args) => {const result=other.query(...args);started();return result;}};
            return ingestCveBatch(observed,[secondEntry]);
          });
          await ready;
          await client.query('COMMIT');
          return await pending;
        } catch (error) {await client.query('ROLLBACK');if(pending) await pending.catch(() => {});throw error;}
        finally {client.release();}
      }
      const id = 'CVE-2099-84001';
      assert.equal((await race(entry(id,'2099-03-01T00:00:00Z'),entry(id,'2099-02-01T00:00:00Z'),false)).stale,1);
      assert.equal((await race(entry(id,'2099-04-01T00:00:00Z'),entry(id,'2099-05-01T00:00:00Z'),true)).updated,1);
      await Promise.all([bulk(pool,[entry(id,'2099-06-01T00:00:00Z')]),importDocument(pool,'cvelist',entry(id,'2099-07-01T00:00:00Z').raw)]);
      assert.equal((await pool.query('SELECT normalized->>\'modified\' modified FROM cve.records WHERE cve_id=$1',[id])).rows[0].modified,'2099-07-01T00:00:00.000Z');
      const a = entry('CVE-2099-84002'), b = entry('CVE-2099-84003');
      await Promise.all([bulk(pool,[a,b]),bulk(pool,[b,a])]);
      assert.equal((await pool.query('SELECT count(*)::int n FROM cve.records WHERE cve_id=ANY($1)',[[a.raw.cveMetadata.cveId,b.raw.cveMetadata.cveId]])).rows[0].n,2);
    });
    await t.test('documented minimum ingester grants support batch inserts, updates and unchanged records', async () => {
      const role = `cve_bulk_ingester_${crypto.randomBytes(8).toString('hex')}`;
      await pool.query(`CREATE ROLE ${role} NOLOGIN`);
      try {
        await pool.query(`GRANT USAGE ON SCHEMA cve TO ${role};
          GRANT SELECT,INSERT ON cve.observations TO ${role};
          GRANT SELECT,INSERT,UPDATE ON cve.records TO ${role};
          GRANT SELECT,INSERT,DELETE ON cve.facets TO ${role};
          GRANT USAGE,SELECT ON SEQUENCE cve.observations_id_seq TO ${role}`);
        const asRole = entries => transaction(pool,async client => {await client.query(`SET LOCAL ROLE ${role}`);return ingestCveBatch(client,entries);});
        assert.equal((await asRole([entry('CVE-2099-85001')])).inserted,1);
        assert.equal((await asRole([entry('CVE-2099-85001')])).unchanged,1);
        assert.equal((await asRole([entry('CVE-2099-85001','2099-02-01T00:00:00Z','mysql')])).updated,1);
        await assert.rejects(() => transaction(pool,async client => {await client.query(`SET LOCAL ROLE ${role}`);await client.query('UPDATE cve.observations SET source_url=source_url');}),e => e.code==='42501');
      } finally {await pool.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);}
    });
    await t.test('a real 500-document batch uses four SQL calls and shares commit with its checkpoint', async () => {
      const entries = Array.from({length:500},(_,i) => entry(`CVE-2099-${86000+i}`));
      let queries = 0;
      await transaction(pool,async client => {
        const observed = {query:(...args) => {queries++;return client.query(...args);}};
        assert.deepEqual(await ingestCveBatch(observed,entries),{inserted:500,updated:0,unchanged:0,stale:0,skipped:0});
        assert.equal(queries,4);
        await checkpoint(client,'bulk-500',{next:500});
        assert.equal((await pool.query("SELECT count(*)::int n FROM cve.records WHERE cve_id BETWEEN 'CVE-2099-86000' AND 'CVE-2099-86499'")).rows[0].n,0);
        assert.equal(await getCheckpoint(pool,'bulk-500'),undefined);
      });
      assert.deepEqual(await getCheckpoint(pool,'bulk-500'),{next:500});
      assert.equal((await bulk(pool,entries.slice().reverse())).unchanged,500);
      assert.equal((await pool.query("SELECT count(*)::int n FROM cve.facets WHERE cve_id BETWEEN 'CVE-2099-86000' AND 'CVE-2099-86499'")).rows[0].n,500);
    });
  });
});
