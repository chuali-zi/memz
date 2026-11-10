'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {temporaryDatabase} = require('./temporary-db');
const {syncManaged,readSyncStatus,verifySnapshot} = require('../managed-sync');
const {getCheckpoint,importDocument,transaction} = require('../store');
const {hashInventory} = require('../git-source');
const fixture = require('./fixtures/cve5.json');
const adminURL = process.env.CVE_TEST_DATABASE_URL;
const commit = digit => digit.repeat(40);
function record(number,modified = '2099-01-01T00:00:00Z',title = 'Synthetic managed source fixture') {
  const raw = structuredClone(fixture), id = `CVE-2099-${number}`;
  raw.cveMetadata.cveId = id;
  raw.cveMetadata.dateUpdated = modified;
  raw.containers.cna.title = title;
  const path = `cves/2099/${String(number).slice(0,-3)}xxx/${id}.json`;
  return {entry:{path,cveId:id,oid:crypto.createHash('sha1').update(JSON.stringify(raw)).digest('hex')},raw};
}
function fakeSource(versions) {
  const snapshots = new Map(versions.map(([id,records]) => [id,records]));
  const state = {head:versions[0][0],cached:null,prepares:[],enumerations:[],reads:[],failAfter:null};
  const sourceProvider = {
    hashInventory,
    async prepareSource(cacheRoot,{fetch = true} = {}) {
      state.prepares.push({cacheRoot,fetch});
      if (fetch) state.cached = state.head;
      assert.ok(state.cached,'resume must use a previously fetched snapshot');
      return {repo:'synthetic-managed-source',commit:state.cached};
    },
    async enumerateSource(repo,target,{baseCommit} = {}) {
      state.enumerations.push({target,baseCommit});
      const all = snapshots.get(target); assert.ok(all,'known target snapshot');
      if (baseCommit && versions.findIndex(([id]) => id===baseCommit)>versions.findIndex(([id]) => id===target)) throw new Error('SOURCE_GIT_FAILED');
      const base = baseCommit ? snapshots.get(baseCommit) : [];
      assert.ok(base,'known base snapshot');
      const previous = new Map(base.map(({entry}) => [entry.path,entry.oid]));
      const paths = new Set(all.map(({entry}) => entry.path));
      return {entries:all.filter(({entry}) => !baseCommit || previous.get(entry.path)!==entry.oid).map(({entry}) => entry),
        inventoryHash:hashInventory(all.map(({entry}) => entry)),total:all.length,
        deleted:base.filter(({entry}) => !paths.has(entry.path)).map(({entry}) => entry.path)};
    },
    async *readSourceEntries(repo,entries) {
      state.reads.push(entries.map(entry => entry.cveId));
      let yielded = 0;
      for (const entry of entries) {
        if (state.failAfter!==null && yielded===state.failAfter) throw new Error('SOURCE_NETWORK_FAILED');
        const found = [...snapshots.values()].flat().find(item => item.entry.oid===entry.oid);
        assert.ok(found,'reader resolves pinned blob identity');
        yield {entry,raw:structuredClone(found.raw)};
        yielded++;
      }
    }
  };
  return {state,sourceProvider};
}
const rows = async (pool,table) => (await pool.query(`SELECT count(*)::int n FROM cve.${table}`)).rows[0].n;
const cursor = pool => getCheckpoint(pool,'managed:cvelist');
const options = (sourceProvider,extra = {}) => ({mode:'incremental',cacheRoot:'synthetic-owned-cache',sourceProvider,batchSize:2,...extra});
async function assertVerified(pool,records) {
  const expected = {total:records.length,inventoryHash:hashInventory(records.map(item => item.entry))};
  await transaction(pool,client => verifySnapshot(client,expected));
  assert.equal(await rows(pool,'source_files'),records.length);
  const saved = await cursor(pool);
  assert.equal(saved.completed.verified,true);
  assert.equal(saved.completed.total,records.length);
  assert.equal(saved.completed.inventory_hash,expected.inventoryHash);
  assert.ok(!saved.pending);
}

test('managed synchronization uses real isolated PostgreSQL batches, manifest verification and recovery', {skip:!adminURL,timeout:120000}, async t => {
  await t.test('sync-now without a baseline completes a full snapshot, then imports only changed blobs', async () => {
    await temporaryDatabase(adminURL,async pool => {
      const initial = [record(90001),record(90002),record(90003)];
      const changed = [initial[0],record(90002,'2099-02-01T00:00:00Z','Updated synthetic source fixture'),initial[2],record(90004)];
      const {sourceProvider,state} = fakeSource([[commit('a'),initial],[commit('b'),changed]]);
      await syncManaged(pool,options(sourceProvider));
      await assertVerified(pool,initial);
      assert.equal(state.enumerations[0].baseCommit,undefined);
      assert.equal(await rows(pool,'observations'),3);
      state.head=commit('b');
      await syncManaged(pool,options(sourceProvider));
      await assertVerified(pool,changed);
      assert.equal(state.enumerations.at(-1).baseCommit,commit('a'));
      assert.deepEqual(state.reads.at(-1),['CVE-2099-90002','CVE-2099-90004']);
      assert.equal(await rows(pool,'observations'),5);
      const saved=await cursor(pool); assert.equal(saved.completed.commit,commit('b'));
      const status=await readSyncStatus(pool);
      assert.equal(status.coverage,'verified_at_last_completed_sync');
      assert.equal(status.completed.commit,commit('b'));
      assert.equal(status.pending,null);
    });
  });
  await t.test('no-change incremental sync preserves record timestamps and observations', async () => {
    await temporaryDatabase(adminURL,async pool => {
      const initial=[record(90101),record(90102)];
      const {sourceProvider,state}=fakeSource([[commit('a'),initial]]);
      await syncManaged(pool,options(sourceProvider));
      const before=(await pool.query('SELECT cve_id,observation_id,last_seen FROM cve.records ORDER BY cve_id')).rows;
      const reads=state.reads.flat().length;
      await syncManaged(pool,options(sourceProvider));
      assert.equal(state.reads.flat().length,reads);
      assert.equal(await rows(pool,'observations'),2);
      assert.deepEqual((await pool.query('SELECT cve_id,observation_id,last_seen FROM cve.records ORDER BY cve_id')).rows,before);
      await assertVerified(pool,initial);
    });
  });
  await t.test('source interruption commits complete batches only and resumes pinned target without fetching', async () => {
    await temporaryDatabase(adminURL,async pool => {
      const initial=Array.from({length:5},(_,i)=>record(90200+i));
      const later=[...initial,record(90205)];
      const {sourceProvider,state}=fakeSource([[commit('a'),initial],[commit('b'),later]]);
      state.failAfter=3;
      await assert.rejects(()=>syncManaged(pool,options(sourceProvider,{mode:'full'})),/SOURCE_NETWORK_FAILED/);
      const pending=(await cursor(pool)).pending;
      assert.equal(pending.nextIndex,2);
      assert.equal(pending.targetCommit,commit('a'));
      const status=await readSyncStatus(pool);
      assert.equal(status.coverage,'partial_update');
      assert.equal(status.pending.nextIndex,2);
      assert.equal(status.runs[0].status,'failed');
      assert.equal(status.runs[0].error_code,'SOURCE_NETWORK_FAILED');
      assert.equal(await rows(pool,'records'),2);
      assert.equal(await rows(pool,'source_files'),2);
      assert.equal(await rows(pool,'observations'),2);
      state.failAfter=null;state.head=commit('b');
      const enumerate=sourceProvider.enumerateSource;
      sourceProvider.enumerateSource=async (...args)=>({...await enumerate(...args),inventoryHash:'0'.repeat(64)});
      await assert.rejects(()=>syncManaged(pool,options(sourceProvider)),/SOURCE_RESUME_MISMATCH/);
      assert.deepEqual((await cursor(pool)).pending,pending);
      assert.equal(await rows(pool,'records'),2);
      sourceProvider.enumerateSource=enumerate;
      await syncManaged(pool,options(sourceProvider,{mode:'full'}));
      assert.deepEqual(state.prepares.map(call=>call.fetch),[true,false,false]);
      assert.deepEqual(state.reads.at(-1),['CVE-2099-90202','CVE-2099-90203','CVE-2099-90204']);
      await assertVerified(pool,initial);
      assert.equal((await cursor(pool)).completed.commit,commit('a'));
    });
  });
  await t.test('a silently truncated source stream retains the last complete batch and can resume', async () => {
    await temporaryDatabase(adminURL,async pool => {
      const initial=Array.from({length:5},(_,i)=>record(90900+i));
      const {sourceProvider}=fakeSource([[commit('a'),initial]]);
      const read=sourceProvider.readSourceEntries;
      sourceProvider.readSourceEntries=async function* (...args) {
        let received=0;
        for await (const item of read(...args)) {if(received++===3) return;yield item;}
      };
      await assert.rejects(()=>syncManaged(pool,options(sourceProvider)),/SOURCE_INCOMPLETE_STREAM/);
      assert.equal((await cursor(pool)).pending.nextIndex,2);
      assert.equal(await rows(pool,'records'),2);
      assert.equal(await rows(pool,'source_files'),2);
      sourceProvider.readSourceEntries=read;
      await syncManaged(pool,options(sourceProvider));
      await assertVerified(pool,initial);
    });
  });
  await t.test('manifest failure rolls back the same batch observations, facets and checkpoint position', async () => {
    await temporaryDatabase(adminURL,async pool => {
      const initial=[record(90301),record(90302)];
      const {sourceProvider}=fakeSource([[commit('a'),initial]]);
      await pool.query(`CREATE FUNCTION public.reject_managed_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.cve_id='CVE-2099-90302' THEN RAISE EXCEPTION 'synthetic manifest failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_managed_manifest BEFORE INSERT ON cve.source_files FOR EACH ROW EXECUTE FUNCTION public.reject_managed_manifest()`);
      try {await assert.rejects(()=>syncManaged(pool,options(sourceProvider)),/synthetic manifest failure/);}
      finally {await pool.query('DROP TRIGGER reject_managed_manifest ON cve.source_files; DROP FUNCTION public.reject_managed_manifest()');}
      for(const table of ['observations','records','facets','source_files']) assert.equal(await rows(pool,table),0);
      assert.equal((await cursor(pool)).pending.nextIndex,0);
      await syncManaged(pool,options(sourceProvider));
      await assertVerified(pool,initial);
    });
  });
  await t.test('upstream deletions or timestamp rollback cannot advance the completed snapshot', async () => {
    await temporaryDatabase(adminURL,async pool => {
      const initial=[record(90401),record(90402)];
      const deleted=[initial[0]],stale=[record(90401,'2098-01-01T00:00:00Z','Stale synthetic correction'),initial[1]];
      const {sourceProvider,state}=fakeSource([[commit('a'),initial],[commit('b'),deleted],[commit('c'),stale]]);
      await syncManaged(pool,options(sourceProvider));
      state.head=commit('b');
      await assert.rejects(()=>syncManaged(pool,options(sourceProvider)),/SOURCE_DELETIONS_REQUIRE_REVIEW/);
      await assert.rejects(()=>syncManaged(pool,options(sourceProvider,{mode:'full'})),/SOURCE_DELETIONS_REQUIRE_REVIEW/);
      assert.equal((await cursor(pool)).completed.commit,commit('a'));
      state.head=commit('c');
      await assert.rejects(()=>syncManaged(pool,options(sourceProvider)),/SOURCE_VERSION_REGRESSION/);
      assert.equal((await cursor(pool)).completed.commit,commit('a'));
      assert.equal(await rows(pool,'observations'),2);
      assert.equal(await rows(pool,'source_files'),2);
    });
  });
  await t.test('snapshot verification rejects hash mismatches, observation drift and extra source records', async () => {
    await temporaryDatabase(adminURL,async pool => {
      const initial=[record(90501),record(90502)];
      const {sourceProvider}=fakeSource([[commit('a'),initial]]);
      await syncManaged(pool,options(sourceProvider));
      const expected={total:2,inventoryHash:hashInventory(initial.map(item=>item.entry))};
      await assert.rejects(()=>transaction(pool,client=>verifySnapshot(client,{...expected,inventoryHash:'0'.repeat(64)})));
      await pool.query("UPDATE cve.source_files SET sha256=$1 WHERE cve_id='CVE-2099-90501'",['0'.repeat(64)]);
      await assert.rejects(()=>transaction(pool,client=>verifySnapshot(client,expected)));
      await pool.query("UPDATE cve.source_files f SET sha256=o.sha256 FROM cve.records r JOIN cve.observations o ON o.id=r.observation_id WHERE f.cve_id=r.cve_id AND f.source=r.source");
      await pool.query("UPDATE cve.records SET normalized=jsonb_set(normalized,'{title}','\"Synthetic normalized drift\"'::jsonb) WHERE cve_id='CVE-2099-90501'");
      await assert.rejects(()=>transaction(pool,client=>verifySnapshot(client,expected)));
      await pool.query("UPDATE cve.records r SET normalized=o.normalized FROM cve.observations o WHERE o.id=r.observation_id");
      await importDocument(pool,'cvelist',record(90503).raw);
      await assert.rejects(()=>transaction(pool,client=>verifySnapshot(client,expected)));
      await assert.rejects(()=>syncManaged(pool,options(sourceProvider)));
    });
  });
  await t.test('upstream commit history rollback is refused without changing the completed baseline', async () => {
    await temporaryDatabase(adminURL,async pool => {
      const first=[record(90701)],second=[...first,record(90702)];
      const {sourceProvider,state}=fakeSource([[commit('a'),first],[commit('b'),second]]);
      await syncManaged(pool,options(sourceProvider));
      state.head=commit('b');await syncManaged(pool,options(sourceProvider));
      state.head=commit('a');
      await assert.rejects(()=>syncManaged(pool,options(sourceProvider)),/SOURCE_GIT_FAILED/);
      await assert.rejects(()=>syncManaged(pool,options(sourceProvider,{mode:'full'})),/SOURCE_GIT_FAILED/);
      assert.equal((await cursor(pool)).completed.commit,commit('b'));
      assert.equal(await rows(pool,'source_files'),2);
    });
  });
  await t.test('completion verifies its inventory and record pointers in a repeatable database snapshot', async () => {
    await temporaryDatabase(adminURL,async pool => {
      const {sourceProvider}=fakeSource([[commit('a'),[record(90801)]]]);
      let verificationQueries=0;
      const observedPool={
        query:(...args)=>pool.query(...args),
        async connect() {
          const client=await pool.connect();
          return {
            release:()=>client.release(),
            async query(sql,...args) {
              if (/SELECT cve_id, path, blob_oid FROM cve\.source_files/.test(sql)) {
                verificationQueries++;
                const isolation=(await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation;
                assert.equal(isolation,'repeatable read','all verification queries must share the same database snapshot');
              }
              return client.query(sql,...args);
            }
          };
        }
      };
      await syncManaged(observedPool,options(sourceProvider));
      assert.equal(verificationQueries,1);
    });
  });
  await t.test('source session lock rejects overlap and releases after source failure', async () => {
    await temporaryDatabase(adminURL,async pool => {
      const {sourceProvider}=fakeSource([[commit('a'),[record(90601)]]]);
      const prepare=sourceProvider.prepareSource;
      let entered,release;
      const ready=new Promise(resolve=>{entered=resolve;});
      const gate=new Promise(resolve=>{release=resolve;});
      sourceProvider.prepareSource=async (...args)=>{entered();await gate;throw new Error('SOURCE_NETWORK_FAILED');};
      const first=syncManaged(pool,options(sourceProvider));
      // Attach the rejection assertion before releasing the blocked provider.
      const failure=assert.rejects(first,/SOURCE_NETWORK_FAILED/);
      try {await ready;await assert.rejects(()=>syncManaged(pool,options(sourceProvider)),/SYNC_BUSY/);}
      finally {release();await failure;}
      sourceProvider.prepareSource=prepare;
      await syncManaged(pool,options(sourceProvider));
      assert.equal((await cursor(pool)).completed.verified,true);
    });
  });
});
