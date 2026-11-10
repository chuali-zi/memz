'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const exec = promisify(execFile);
const {Client, Pool} = require('pg');
const {importDocument, transaction, getCheckpoint} = require('../store');
const {search} = require('../query');
const {syncNvd, syncKev, syncGit, importPath, withSyncLock} = require('../sync');
const {createApp} = require('../server');
const {readContext} = require('../client');
const cve = require('./fixtures/cve5.json'), nvd = require('./fixtures/nvd.json'), ghsa = require('./fixtures/ghsa.json'), kev = require('./fixtures/kev.json');
const adminURL = process.env.CVE_TEST_DATABASE_URL;
test('isolated PostgreSQL CVE migration, lifecycle, sync, retrieval, HTTP and MCP', {skip: !adminURL, timeout: 120000}, async t => {
  const admin = new Client({connectionString: adminURL}); await admin.connect();
  const name = `memz_cve_test_${crypto.randomBytes(8).toString('hex')}`;
  const role = `cve_reader_${crypto.randomBytes(8).toString('hex')}`;
  let pool, server, dir, mcp;
  const connectionsClosed=[];
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(adminURL); url.pathname = `/${name}`;
    pool = new Pool({connectionString: url.href, max: 6});
    // pg-pool's end promise may resolve before idle sockets finish closing.
    // Wait for actual end events before dropping this test's database.
    pool.on('connect',client=>connectionsClosed.push(new Promise(resolve=>client.once('end',resolve))));
    const migration = await fs.readFile(path.join(__dirname,'..','..','db','cve_schema.sql'), 'utf8');
    await t.test('additive repeatable migration preserves preexisting memory data and PUBLIC has no access', async () => {
      await pool.query("CREATE TABLE public.memory_sentinel(value text); INSERT INTO public.memory_sentinel VALUES('existing memory')");
      await pool.query(migration); await pool.query(migration);
      assert.equal((await pool.query('SELECT value FROM public.memory_sentinel')).rows[0].value, 'existing memory');
      await admin.query(`CREATE ROLE ${role} NOLOGIN`);
      await assert.rejects(() => transaction(pool, async c => {await c.query(`SET LOCAL ROLE ${role}`); await c.query('SELECT * FROM cve.records');}), e => e.code === '42501');
      await pool.query(`GRANT USAGE ON SCHEMA cve TO ${role}; GRANT SELECT ON cve.records,cve.observations,cve.facets TO ${role}`);
    });
    await t.test('idempotency, stale updates, complete independent sources, immutable old evidence', async () => {
      assert.equal((await importDocument(pool, 'cvelist', cve)).inserted, 1);
      const first = (await search(pool, {id: 'CVE-2099-10001'})).items[0].sources[0];
      assert.equal((await importDocument(pool, 'cvelist', cve)).unchanged, 1);
      const older = structuredClone(cve); older.cveMetadata.dateUpdated = '2098-01-01T00:00:00Z'; older.containers.cna.title = 'old';
      assert.equal((await importDocument(pool, 'cvelist', older)).stale, 1);
      await Promise.all([importDocument(pool,'nvd',nvd), importDocument(pool,'ghsa',ghsa), importDocument(pool,'kev',kev)]);
      const all = await search(pool, {id: 'CVE-2099-10001'}); assert.equal(all.items[0].sources.length, 4); assert.equal(all.items[0].known_exploited, true);
      assert.equal((await pool.query('SELECT count(*)::int n FROM cve.observations')).rows[0].n, 4);
      assert.deepEqual((await pool.query('SELECT raw FROM cve.observations WHERE id=$1',[first.observation_id])).rows[0].raw, cve);
      assert.equal((await search(pool, {vendor:'examplevendor',product:'examplewidget',version:'1.1.0'})).version_assessment, 'requires_ecosystem_specific_evaluation');
      assert.equal((await search(pool, {q:'SQL injection',cwe:'CWE-89',kev:'true'})).items.length, 1);
      assert.equal((await search(pool, {vendor:'examplevendor',product:'exampleos'})).items.length, 0);
      assert.equal((await search(pool, {q:"');DROP TABLE cve.records;--"})).items.length, 0);
    });
    await t.test('rejection hides all source matches; exact lookup and observations retain evidence', async () => {
      const rejected = structuredClone(cve); rejected.cveMetadata.state = 'REJECTED'; rejected.cveMetadata.dateUpdated = '2099-01-06T00:00:00Z';
      rejected.containers.cna.rejectedReasons = [{lang:'en',value:'Synthetic duplicate'}];
      await importDocument(pool,'cvelist',rejected);
      assert.equal((await search(pool,{q:'SQL injection'})).items.length, 0);
      assert.equal((await search(pool,{id:'CVE-2099-10001',include_rejected:'true'})).items[0].state, 'REJECTED');
      const republished = structuredClone(cve); republished.cveMetadata.dateUpdated = '2099-01-07T00:00:00Z';
      await importDocument(pool,'cvelist',republished);
    });
    await t.test('GHSA alias removal detaches current links and stale snapshots cannot restore them', async () => {
      const more = {...ghsa, aliases: [...ghsa.aliases,'CVE-2099-10002'], modified: '2099-01-08T00:00:00Z'};
      await importDocument(pool,'ghsa',more);
      assert.equal((await search(pool,{id:'CVE-2099-10002'})).items.length,1);
      await importDocument(pool,'ghsa',{...more,aliases:ghsa.aliases,modified:'2099-01-09T00:00:00Z'});
      assert.equal((await search(pool,{id:'CVE-2099-10002'})).items.length,0);
      assert.equal((await importDocument(pool,'ghsa',more)).stale,1);
      const noAliases = {...more,aliases:[],modified:'2099-01-10T00:00:00Z'};
      await importDocument(pool,'ghsa',noAliases);
      assert.equal((await importDocument(pool,'ghsa',more)).stale,1);
      assert.equal((await pool.query("SELECT count(*)::int n FROM cve.records WHERE source='ghsa'")).rows[0].n,0);
      await importDocument(pool,'ghsa',{...ghsa,modified:'2099-01-11T00:00:00Z'});
    });
    await t.test('NVD page failure preserves committed cursor and resumes; invalid page rolls back', async () => {
      const ids = ['CVE-2099-20001','CVE-2099-20002'];
      const page = (index, id) => ({startIndex:index,totalResults:2,vulnerabilities:[{cve:{...nvd.vulnerabilities[0].cve,id}}]});
      let calls = 0;
      await assert.rejects(() => syncNvd(pool,{start:'2099-01-01',end:'2099-01-10',download:async () => {if(calls++)throw new Error('SOURCE_NETWORK_FAILED');return page(0,ids[0]);}}),/SOURCE_NETWORK_FAILED/);
      assert.equal((await getCheckpoint(pool,'nvd')).next_index,1);
      await assert.rejects(()=>syncNvd(pool,{start:'2099-01-02',end:'2099-01-10',download:async()=>{throw new Error('SHOULD_NOT_DOWNLOAD');}}),/NVD_PENDING_WINDOW_MISMATCH/);
      await syncNvd(pool,{download:async url => {assert.equal(new URL(url).searchParams.get('startIndex'),'1');return page(1,ids[1]);}});
      assert.equal((await getCheckpoint(pool,'nvd')).completed_end,'2099-01-10T00:00:00.000Z');
      const before = await getCheckpoint(pool,'nvd');
      await assert.rejects(() => syncNvd(pool,{start:'2099-01-09',end:'2099-01-11',download:async () => ({startIndex:0,totalResults:2,vulnerabilities:[{cve:{...nvd.vulnerabilities[0].cve,id:'CVE-2099-30001'}},{cve:{id:'broken'}}]})}));
      assert.deepEqual(await getCheckpoint(pool,'nvd'),before);
      assert.equal((await search(pool,{id:'CVE-2099-30001'})).items.length,0);
      assert.equal((await pool.query("SELECT count(*)::int n FROM cve.sync_runs WHERE status='failed'")).rows[0].n,3);
      const paged = await search(pool,{q:'SQL injection',limit:'1'}); assert.ok(paged.next_after);
      const next = await search(pool,{q:'SQL injection',limit:'1',after:paged.next_after}); assert.ok(next.items[0].cve_id > paged.items[0].cve_id);
    });
    await t.test('KEV snapshot removal updates membership, retaining original observations', async () => {
      await syncKev(pool,{download:async () => kev});
      await syncKev(pool,{download:async () => ({...kev,count:0,dateReleased:'2099-01-10T00:00:00Z',vulnerabilities:[]})});
      assert.equal((await search(pool,{id:'CVE-2099-10001'})).items[0].known_exploited,false);
      assert.equal((await pool.query("SELECT count(*)::int n FROM cve.observations WHERE source='kev'")).rows[0].n,1);
    });
    await t.test('read role cannot import; transactions used by reads reject writes; sync lock excludes overlap', async () => {
      await transaction(pool,async c => {await c.query(`SET LOCAL ROLE ${role}`); assert.equal((await c.query('SELECT count(*) FROM cve.records')).rowCount,1);});
      await assert.rejects(() => transaction(pool,async c => {await c.query(`SET LOCAL ROLE ${role}`);await c.query('DELETE FROM cve.records');}),e=>e.code==='42501');
      await assert.rejects(() => transaction(pool,c=>c.query('DELETE FROM cve.records'),{readOnly:true}),e=>e.code==='25006');
      await withSyncLock(pool,'nvd',async () => assert.rejects(()=>syncNvd(pool),/SYNC_BUSY/));
    });
    await t.test('concurrent updates serialize per source/CVE and the latest source version wins', async () => {
      const older=structuredClone(cve);older.cveMetadata.cveId='CVE-2099-60001';
      older.containers={cna:{title:'concurrency_marker',descriptions:[{lang:'en',value:'Synthetic concurrency fixture'}],affected:[]}};
      const newer=structuredClone(older);newer.cveMetadata.dateUpdated='2099-02-01T00:00:00Z';newer.containers.cna.title='new concurrency_marker';
      await Promise.all([importDocument(pool,'cvelist',newer),importDocument(pool,'cvelist',older),importDocument(pool,'cvelist',newer)]);
      const row=(await search(pool,{id:'CVE-2099-60001'})).items[0];
      assert.equal(row.sources[0].record.title,'new concurrency_marker');
      assert.equal((await pool.query("SELECT count(*)::int n FROM cve.records WHERE cve_id='CVE-2099-60001'")).rows[0].n,1);
    });
    await t.test('pinned Git import ignores dirty worktree; rerun and incremental sync; broken JSON does not advance checkpoint', async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(),'memz-cve-test-'));
      const git = args => exec('git',['-C',dir,...args],{windowsHide:true});
      await git(['init']); await git(['remote','add','origin','https://github.com/CVEProject/cvelistV5.git']);
      const relative = 'cves/2099/40xxx/CVE-2099-40001.json', file = path.join(dir,relative);
      await fs.mkdir(path.dirname(file),{recursive:true});
      const record = structuredClone(cve);record.cveMetadata.cveId='CVE-2099-40001';
      await fs.writeFile(file,JSON.stringify(record));await git(['add','.']);
      const commit = () => git(['-c','user.name=Synthetic Fixture','-c','user.email=fixture@example.invalid','commit','-m','synthetic fixture']);
      await commit(); await fs.writeFile(file,'dirty and invalid');
      await syncGit(pool,'cvelist',dir); assert.equal((await search(pool,{id:'CVE-2099-40001'})).items.length,1);
      assert.equal((await syncGit(pool,'cvelist',dir)).counts.unchanged_snapshot,1);
      await fs.writeFile(file,JSON.stringify({...record,cveMetadata:{...record.cveMetadata,dateUpdated:'2099-02-01T00:00:00Z'}}));await git(['add','.']);await commit();
      assert.equal((await syncGit(pool,'cvelist',dir)).counts.updated,1);
      const before = await getCheckpoint(pool,'git:cvelist');
      await fs.writeFile(file,'invalid');await git(['add','.']);await commit();
      await assert.rejects(()=>syncGit(pool,'cvelist',dir),/INVALID_SOURCE_FILE/);assert.deepEqual(await getCheckpoint(pool,'git:cvelist'),before);
      await fs.unlink(file);await git(['add','-u']);await commit();
      await assert.rejects(()=>syncGit(pool,'cvelist',dir),/SOURCE_DELETIONS_REQUIRE_REVIEW/);assert.deepEqual(await getCheckpoint(pool,'git:cvelist'),before);
      const imports = path.join(dir,'imports');await fs.mkdir(imports);await fs.writeFile(path.join(imports,'CVE-2099-10001.json'),JSON.stringify(cve));
      assert.equal((await importPath(pool,'cvelist',imports)).counts.files,1);
    });
    await t.test('HTTP exact lookup, unknowns, provenance, strict validation, methods and agent context', async () => {
      server = createApp(pool).listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      assert.equal((await fetch(`${base}/health/ready`)).status,200);
      assert.equal((await fetch(`${base}/api/cve/CVE-2099-99999`)).status,404);
      assert.equal((await fetch(`${base}/api/cve/search?q=x&q=y`)).status,400);
      assert.equal((await fetch(`${base}/api/cve/search`)).status,400);
      assert.equal((await fetch(`${base}/api/cve/CVE-2099-10001`,{method:'POST'})).status,405);
      assert.equal((await fetch(`${base}/api/cve/CVE-2099-10001`,{headers:{Origin:'https://evil.invalid'}})).status,403);
      const response = await fetch(`${base}/api/cve/CVE-2099-10001`);assert.equal(response.headers.get('cache-control'),'no-store');
      const detail = await response.json();assert.equal(detail.items[0].sources.length,3);
      assert.equal(detail.items[0].sources[0].excerpt,true);
      assert.equal(detail.items[0].sources[0].record.version_evidence,'read_full_observation');
      assert.equal(detail.items[0].sources[0].record.affected,undefined);
      const old = await (await fetch(`${base}/api/cve/observations/${detail.citations[0].observation_id}`)).json();assert.ok(old.observation.raw);
      const context = await readContext({id:'CVE-2099-10001'},{url:base});assert.equal(context.untrusted_data,true);assert.ok(context.citations.length);
      const {Client: McpClient} = require('@modelcontextprotocol/sdk/client/index.js');
      const {StdioClientTransport} = require('@modelcontextprotocol/sdk/client/stdio.js');
      const transport = new StdioClientTransport({command:process.execPath,args:[path.join(__dirname,'..','..','scripts','cve_mcp.js')],env:{...process.env,CVE_BASE_URL:base},stderr:'pipe'});
      mcp = new McpClient({name:'cve-fixture',version:'1.0.0'});await mcp.connect(transport);
      assert.deepEqual((await mcp.listTools()).tools.map(x=>x.name),['cve_capabilities','cve_browse_tree','cve_read_context','cve_read_observation','cve_sync_status']);
      const result = await mcp.callTool({name:'cve_read_context',arguments:{id:'CVE-2099-10001',limit:1}});assert.equal(result.isError,false);
      assert.equal(JSON.parse(result.content[0].text).items[0].cve_id,'CVE-2099-10001');
      const invalid = await mcp.callTool({name:'cve_read_context',arguments:{q:'x',limit:51}});assert.equal(invalid.isError,true);
      await mcp.close();mcp=null;
      for(let i=0;i<30;i++){
        const big=structuredClone(cve);big.cveMetadata.cveId=`CVE-2099-${50000+i}`;
        big.containers={cna:{title:'budget_marker',descriptions:[{lang:'en',value:'x'.repeat(1300)},{lang:'zh',value:'y'.repeat(1300)}],affected:[]}};
        await importDocument(pool,'cvelist',big);
      }
      const overflow=await fetch(`${base}/api/cve/context?q=budget_marker&limit=50`);
      assert.equal(overflow.status,413);assert.equal((await overflow.json()).error,'OUTPUT_BUDGET_EXCEEDED');
      assert.equal((await fetch(`${base}/api/cve/context?q=budget_marker&limit=1`)).status,200);
    });
    assert.equal((await pool.query('SELECT value FROM public.memory_sentinel')).rows[0].value,'existing memory');
  } finally {
    if (mcp) await mcp.close();
    if (server) {server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));}
    if (pool) {await pool.end();await Promise.all(connectionsClosed);}
    // Delete only resources created by this test, with validated names/paths.
    if (/^memz_cve_test_[a-f0-9]{16}$/.test(name)) await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    if (/^cve_reader_[a-f0-9]{16}$/.test(role)) await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
    if (dir && path.dirname(path.resolve(dir))===path.resolve(os.tmpdir()) && path.basename(dir).startsWith('memz-cve-test-')) await fs.rm(dir,{recursive:true,force:true});
  }
});
