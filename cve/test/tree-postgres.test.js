'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {Pool} = require('pg');
const {temporaryDatabase} = require('./temporary-db');
const {importDocument, transaction} = require('../store');
const {browseTree} = require('../tree');
const {search, evidenceContext} = require('../query');
const {createApp} = require('../server');
const {readCapabilities, readTree, readContext, readObservation} = require('../client');
const fixture = require('./fixtures/cve5.json');
const ghsaFixture = require('./fixtures/ghsa.json');
const adminURL = process.env.CVE_TEST_DATABASE_URL;

function cve(id, products, cwes = ['CWE-89']) {
  const raw = structuredClone(fixture);
  raw.cveMetadata.cveId = id;
  raw.containers = {cna: {...raw.containers.cna,
    affected: products.map(([vendor, product]) => ({vendor, product, defaultStatus:'unaffected',versions:[{version:'1',lessThan:'2',status:'affected',versionType:'custom'}]})),
    problemTypes: cwes.map(cweId => ({descriptions:[{lang:'en',cweId}]}))}};
  return raw;
}
const ids = result => result.items.map(i => i.cve_id);

test('isolated PostgreSQL tree discovery, evidence navigation and projection lifecycle', {skip:!adminURL, timeout:120000}, async t => {
  await temporaryDatabase(adminURL, async pool => {
    let server, mcp;
    try {
      server = createApp(pool).listen(0,'127.0.0.1');
      await new Promise(resolve => server.once('listening',resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      const http = async (route, query = {}) => fetch(`${base}${route}?${new URLSearchParams(query)}`);
      await t.test('empty database discovers capabilities and returns honest empty navigation and context', async () => {
        const discovery = await readCapabilities({}, {url:base});
        assert.equal(discovery.modes.tree.enabled,true);
        assert.equal(discovery.modes.natural_language.enabled,false);
        const root = await readTree({}, {url:base});
        assert.deepEqual(root.nodes,[]); assert.equal(root.next_after,null);
        assert.match(root.empty_guidance,/not proof of absence/);
        const context = await readContext({stack:'web'}, {url:base});
        assert.deepEqual(context.items,[]); assert.deepEqual(context.citations,[]);
      });

      const first = cve('CVE-2099-71001', [['Vendor A','nginx'],['Vendor A','mysql'],['Vendor A','nginx']], ['CWE-89','CWE-22']);
      const second = cve('CVE-2099-71002', [['Vendor B','nginx']], ['CWE-79']);
      const third = cve('CVE-2099-71003', [['Vendor A','nginx']], ['CWE-89']);
      const unknown = cve('CVE-2099-71004', [['Unmapped Vendor','unknown-service']], []);
      for (const raw of [first,second,third,unknown]) await importDocument(pool,'cvelist',raw);

      let serviceA, serviceB;
      await t.test('same product across vendors has distinct opaque services and multiple paths count distinct CVEs', async () => {
        const root = await browseTree(pool);
        assert.deepEqual(root.nodes.map(n => [n.key,n.cve_count]), [['other',1],['sql',1],['web',3]]);
        const services = await browseTree(pool,{stack:'web',product:'ngix'});
        assert.equal(services.nodes.length,2);
        serviceA = services.nodes.find(n => n.vendor === 'vendor a');
        serviceB = services.nodes.find(n => n.vendor === 'vendor b');
        assert.match(serviceA.key,/^[a-f0-9]{64}$/); assert.notEqual(serviceA.key,serviceB.key);
        assert.equal(serviceA.cve_count,2); assert.equal(serviceB.cve_count,1);
        const web = await search(pool,{stack:'web'});
        assert.deepEqual(ids(web),['CVE-2099-71001','CVE-2099-71002','CVE-2099-71003']);
        assert.deepEqual(ids(await search(pool,{stack:'sql',cwe:'CWE-89'})),['CVE-2099-71001']);
        assert.deepEqual(ids(await search(pool,{stack:'web',cwe:'CWE-89'})),['CVE-2099-71001','CVE-2099-71003']);
        assert.deepEqual(ids(await search(pool,{stack:'web',service:serviceB.key,cwe:'CWE-89'})),[]);
        assert.deepEqual(ids(await search(pool,{product:'ngix'})),[]);
      });

      await t.test('all three node levels page stably and cursors cannot move to a different scope', async () => {
        for (const scope of [{}, {stack:'web'}, {stack:'web',service:serviceA.key}]) {
          const all = await browseTree(pool,{...scope,limit:'50'});
          const collected = []; let query = {...scope,limit:'1'};
          do {
            const page = await readTree(query,{url:base});
            collected.push(...page.nodes.map(n => n.key));
            query = page.next_query;
          } while (query);
          assert.deepEqual(collected,all.nodes.map(n => n.key));
          assert.equal(new Set(collected).size,collected.length);
        }
        const page = await browseTree(pool,{stack:'web',limit:'1'});
        assert.ok(page.next_after);
        await assert.rejects(() => browseTree(pool,{stack:'sql',after:page.next_after}), /INVALID_QUERY/);
        await assert.rejects(() => browseTree(pool,{stack:'web',product:'nginx',after:page.next_after}), /INVALID_QUERY/);
        const one = await search(pool,{stack:'web',service:serviceA.key,cwe:'CWE-89',limit:'1'});
        assert.equal(one.next_after,'CVE-2099-71001');
        assert.deepEqual(ids(await search(pool,{stack:'web',service:serviceA.key,cwe:'CWE-89',limit:'1',after:one.next_after})),['CVE-2099-71003']);
      });

      await t.test('unknown product and missing affected/CWE fields remain browsable with explicit evidence gaps', async () => {
        const sparse = cve('CVE-2099-71005',[],[]);
        delete sparse.containers.cna.descriptions; delete sparse.containers.cna.metrics; delete sparse.containers.cna.references;
        await importDocument(pool,'cvelist',sparse);
        const other = await browseTree(pool,{stack:'other'});
        assert.equal(other.nodes.length,2);
        for (const service of other.nodes) {
          const weaknesses = await browseTree(pool,service.next_query);
          assert.deepEqual(weaknesses.nodes.map(n => n.key),['unclassified']);
        }
        const sparseContext = evidenceContext(await search(pool,{id:'CVE-2099-71005'}));
        assert.deepEqual(sparseContext.items[0].investigation.missing_by_source[0].fields,
          ['description','affected_products','version_or_configuration_evidence','cwe','severity','tagged_fix_or_vendor_advisory']);
        assert.deepEqual(sparseContext.items[0].investigation.weakness_checks,[]);
      });

      await t.test('a service and CWE must coexist in one source; conflicting sources remain cited but do not generate matching rules', async () => {
        const id = 'CVE-2099-71006';
        await importDocument(pool,'cvelist',cve(id,[['Vendor A','nginx']],['CWE-22']));
        const otherSource = {...structuredClone(ghsaFixture),aliases:[id]};
        await importDocument(pool,'ghsa',otherSource);
        assert.deepEqual(ids(await search(pool,{stack:'web',service:serviceA.key,cwe:'CWE-89'})),['CVE-2099-71001','CVE-2099-71003']);
        const context = evidenceContext(await search(pool,{stack:'web',service:serviceA.key,cwe:'CWE-22',id}));
        assert.equal(context.items[0].sources.length,2);
        assert.equal(context.items[0].sources.filter(s => s.matched).length,1);
        assert.deepEqual(context.items[0].investigation.weakness_checks.map(x => x.cwe),['CWE-22']);
        assert.equal(context.citations.length,2);
      });

      await t.test('HTTP and MCP complete discovery -> stack -> service -> CWE -> candidates -> full immutable observation', async () => {
        const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
        const {StdioClientTransport} = require('@modelcontextprotocol/sdk/client/stdio.js');
        mcp = new Client({name:'tree-fixture',version:'1.0.0'});
        await mcp.connect(new StdioClientTransport({command:process.execPath,args:[path.join(__dirname,'..','..','scripts','cve_mcp.js')],env:{...process.env,CVE_BASE_URL:base},stderr:'pipe'}));
        const tools = (await mcp.listTools()).tools;
        assert.deepEqual(tools.map(x => x.name),['cve_capabilities','cve_browse_tree','cve_read_context','cve_read_observation']);
        assert.ok(tools.every(x => x.annotations.readOnlyHint && !x.annotations.destructiveHint));
        const call = async (name,args = {}) => {
          const response = await mcp.callTool({name,arguments:args});
          assert.equal(response.isError,false,JSON.stringify(response));
          return JSON.parse(response.content[0].text);
        };
        assert.equal((await call('cve_capabilities')).domain,'vulnerability_knowledge_and_cve_details');
        const root = await call('cve_browse_tree');
        const services = await call('cve_browse_tree',root.nodes.find(n => n.key === 'web').next_query);
        const weaknesses = await call('cve_browse_tree',services.nodes.find(n => n.vendor === 'vendor a').next_query);
        const query = weaknesses.nodes.find(n => n.key === 'CWE-89').context_query;
        const context = await call('cve_read_context',{...query,limit:1});
        assert.equal(context.items[0].match.kind,'candidate_not_target_verdict');
        const citation = context.citations[0];
        const observation = (await call('cve_read_observation',{id:citation.observation_id})).observation;
        assert.equal(observation.sha256,citation.sha256);
        assert.deepEqual(observation.raw,first);
        assert.equal(observation.normalized.affected[0].versions[0].lessThan,'2');
        assert.equal(context.items[0].sources[0].record.affected,undefined);
        const clientTree = await readTree({stack:'web',product:'ngix'},{url:base});
        const clientContext = await readContext({...query,limit:1,version:'1.5'},{url:base});
        assert.equal(clientTree.nodes.length,2);
        assert.equal(clientContext.version_assessment,'requires_ecosystem_specific_evaluation');
        assert.deepEqual((await readObservation({id:citation.observation_id},{url:base})).observation.raw,first);
        const unsupported = await mcp.callTool({name:'cve_read_context',arguments:{mode:'natural_language',q:'what affects nginx'}});
        assert.equal(unsupported.isError,true);
        assert.equal(JSON.parse(unsupported.content[0].text).error,'RETRIEVAL_MODE_NOT_IMPLEMENTED');
        await mcp.close(); mcp = null;
      });

      await t.test('HTTP validates discovery, scope, duplicates and unsupported strategies with explicit errors', async () => {
        for (const [route, query] of [
          ['/api/cve/capabilities',{q:'x'}],['/api/cve/tree',{stack:'unknown'}],['/api/cve/tree',{service:serviceA.key}],
          ['/api/cve/tree',{cwe:'CWE-89'}],['/api/cve/tree',{stack:'web',service:serviceA.key,product:'nginx'}],
          ['/api/cve/context',{stack:'web',service:'no'}]
        ]) assert.equal((await http(route,query)).status,400,route+JSON.stringify(query));
        assert.equal((await fetch(`${base}/api/cve/tree?stack=web&stack=sql`)).status,400);
        const response = await http('/api/cve/context',{mode:'natural_language',q:'nginx issue'});
        assert.equal(response.status,501); assert.equal((await response.json()).error,'RETRIEVAL_MODE_NOT_IMPLEMENTED');
        assert.equal((await fetch(`${base}/api/cve/tree`,{method:'POST'})).status,405);
        assert.equal((await http('/api/cve/observations/99999999')).status,404);
      });

      await t.test('source updates, authoritative rejection and GHSA alias removal refresh paths without deleting history', async () => {
        const oldCitation = evidenceContext(await search(pool,{id:'CVE-2099-71002'})).citations[0];
        const updated = cve('CVE-2099-71002',[['Vendor B','postgresql']],['CWE-78']);
        updated.cveMetadata.dateUpdated = '2099-03-01T00:00:00Z';
        await importDocument(pool,'cvelist',updated);
        assert.deepEqual((await browseTree(pool,{stack:'web',product:'nginx'})).nodes.map(n => n.vendor),['vendor a']);
        assert.equal((await search(pool,{stack:'sql',product:'postgresql',cwe:'CWE-78'})).items.length,1);
        assert.deepEqual((await readObservation({id:oldCitation.observation_id},{url:base})).observation.raw,second);
        const rejected = structuredClone(first); rejected.cveMetadata.state = 'REJECTED'; rejected.cveMetadata.dateUpdated = '2099-03-02T00:00:00Z';
        rejected.containers.cna.rejectedReasons = [{lang:'en',value:'Synthetic withdrawal'}];
        await importDocument(pool,'cvelist',rejected);
        assert.deepEqual(ids(await search(pool,{stack:'sql',product:'mysql'})),[]);
        assert.equal((await search(pool,{id:'CVE-2099-71001',include_rejected:'true'})).items[0].state,'REJECTED');
        const advisory = {...structuredClone(ghsaFixture),id:'GHSA-3456-789c-fghj',aliases:['CVE-2099-71007'],modified:'2099-04-01T00:00:00Z'};
        await importDocument(pool,'ghsa',advisory);
        assert.equal((await browseTree(pool,{stack:'javascript'})).nodes[0].cve_count,2);
        await importDocument(pool,'ghsa',{...advisory,aliases:[],modified:'2099-04-02T00:00:00Z'});
        assert.equal((await pool.query("SELECT count(*)::int n FROM cve.facets WHERE cve_id='CVE-2099-71007'")).rows[0].n,0);
        assert.equal((await importDocument(pool,'ghsa',advisory)).stale,1);
        assert.equal((await pool.query("SELECT count(*)::int n FROM cve.observations WHERE cve_id='CVE-2099-71007'")).rows[0].n,1);
      });

      await t.test('migration backfills a pre-tree current dataset, is repeatable and preserves all evidence and checkpoints', async () => {
        const before = (await pool.query('SELECT source,source_id,cve_id,observation_id,normalized,last_seen FROM cve.records ORDER BY source,source_id,cve_id')).rows;
        await pool.query("INSERT INTO cve.checkpoints(name,cursor) VALUES('tree-migration-fixture','{\"preserve\":true}')");
        const observations = (await pool.query('SELECT * FROM cve.observations ORDER BY id')).rows;
        await pool.query('DROP TRIGGER cve_refresh_facets ON cve.records; DROP TABLE cve.facets');
        const migration = await fs.readFile(path.join(__dirname,'..','..','db','cve_schema.sql'),'utf8');
        await pool.query(migration); const count = (await pool.query('SELECT count(*)::int n FROM cve.facets')).rows[0].n;
        assert.ok(count > 0); await pool.query(migration);
        assert.equal((await pool.query('SELECT count(*)::int n FROM cve.facets')).rows[0].n,count);
        assert.deepEqual((await pool.query('SELECT source,source_id,cve_id,observation_id,normalized,last_seen FROM cve.records ORDER BY source,source_id,cve_id')).rows,before);
        assert.deepEqual((await pool.query('SELECT * FROM cve.observations ORDER BY id')).rows,observations);
        assert.deepEqual((await pool.query("SELECT cursor FROM cve.checkpoints WHERE name='tree-migration-fixture'")).rows[0].cursor,{preserve:true});
        assert.ok((await browseTree(pool)).nodes.length);
        // Upgrade an existing projection whose newly added state column is physically last.
        await pool.query('ALTER TABLE cve.facets DROP COLUMN state');
        await pool.query(migration);
        assert.equal((await pool.query('SELECT count(*)::int n FROM cve.facets')).rows[0].n,count);
        assert.equal((await pool.query("SELECT count(*)::int n FROM cve.facets f JOIN cve.records r USING(source,source_id,cve_id) WHERE f.state IS DISTINCT FROM r.normalized->>'state'")).rows[0].n,0);
        const updated = structuredClone(third); updated.cveMetadata.dateUpdated = '2099-05-01T00:00:00Z';
        await importDocument(pool,'cvelist',updated);
        const projection = (await pool.query("SELECT state,stack,product FROM cve.facets WHERE cve_id='CVE-2099-71003'")).rows;
        assert.deepEqual(projection,[{state:'PUBLISHED',stack:'web',product:'nginx'}]);
      });

      await t.test('a dedicated SELECT-only role browses tree and context but cannot change projection or ingest', async () => {
        const role = `cve_tree_reader_${crypto.randomBytes(8).toString('hex')}`;
        let reader; const closed = [];
        await pool.query(`CREATE ROLE ${role} NOLOGIN`);
        try {
          await pool.query(`GRANT USAGE ON SCHEMA cve TO ${role}; GRANT SELECT ON cve.records,cve.facets,cve.observations TO ${role}`);
          reader = new Pool({connectionString:pool.options.connectionString,options:`-c role=${role}`,max:2});
          reader.on('connect', c => closed.push(new Promise(resolve => c.once('end',resolve))));
          assert.ok((await browseTree(reader)).nodes.length);
          assert.ok((await search(reader,{stack:'web'})).items.length);
          for (const table of ['facets','records','observations']) await assert.rejects(() => reader.query(`DELETE FROM cve.${table}`),e => e.code === '42501');
          await assert.rejects(() => importDocument(reader,'cvelist',cve('CVE-2099-71008',[['V','nginx']])),e => e.code === '42501');
          await assert.rejects(() => transaction(pool,c => c.query('DELETE FROM cve.facets'),{readOnly:true}),e => e.code === '25006');
        } finally {
          if (reader) {await reader.end(); await Promise.all(closed);}
          await pool.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
        }
      });

      await t.test('documented ingester grants support insert, unchanged, update and GHSA unlink without facets UPDATE', async () => {
        const role = `cve_tree_ingester_${crypto.randomBytes(8).toString('hex')}`;
        let ingester; const closed = [];
        await pool.query(`CREATE ROLE ${role} NOLOGIN`);
        try {
          await pool.query(`GRANT USAGE ON SCHEMA cve TO ${role};
            GRANT SELECT, INSERT ON cve.observations TO ${role};
            GRANT SELECT, INSERT, UPDATE, DELETE ON cve.records TO ${role};
            GRANT SELECT, INSERT, DELETE ON cve.facets TO ${role};
            GRANT SELECT, INSERT, UPDATE ON cve.source_state, cve.checkpoints, cve.sync_runs TO ${role};
            GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA cve TO ${role}`);
          ingester = new Pool({connectionString:pool.options.connectionString,options:`-c role=${role}`,max:2});
          ingester.on('connect', c => closed.push(new Promise(resolve => c.once('end',resolve))));
          assert.equal((await ingester.query("SELECT has_table_privilege(current_user,'cve.facets','UPDATE') allowed")).rows[0].allowed,false);
          await assert.rejects(() => ingester.query("UPDATE cve.facets SET state='PUBLISHED' WHERE false"),e => e.code === '42501');
          const raw = cve('CVE-2099-71009',[['Ingest Test Vendor','nginx']],['CWE-22']);
          assert.equal((await importDocument(ingester,'cvelist',raw)).inserted,1);
          const original = (await ingester.query("SELECT observation_id FROM cve.records WHERE cve_id='CVE-2099-71009'")).rows[0].observation_id;
          assert.equal((await importDocument(ingester,'cvelist',raw)).unchanged,1);
          assert.equal((await ingester.query("SELECT count(*)::int n FROM cve.observations WHERE cve_id='CVE-2099-71009'")).rows[0].n,1);
          const updated = cve('CVE-2099-71009',[['Ingest Test Vendor','postgresql']],['CWE-78']);
          updated.cveMetadata.dateUpdated = '2099-06-01T00:00:00Z';
          assert.equal((await importDocument(ingester,'cvelist',updated)).updated,1);
          assert.deepEqual((await ingester.query("SELECT state,stack,product,cwe FROM cve.facets WHERE cve_id='CVE-2099-71009'")).rows,
            [{state:'PUBLISHED',stack:'sql',product:'postgresql',cwe:'CWE-78'}]);
          assert.deepEqual((await ingester.query('SELECT raw FROM cve.observations WHERE id=$1',[original])).rows[0].raw,raw);
          const advisory = {...structuredClone(ghsaFixture),id:'GHSA-4567-89cf-ghjm',aliases:['CVE-2099-71010','CVE-2099-71011'],modified:'2099-06-01T00:00:00Z'};
          assert.equal((await importDocument(ingester,'ghsa',advisory)).inserted,2);
          const partial = {...advisory,aliases:['CVE-2099-71011'],modified:'2099-06-02T00:00:00Z'};
          assert.equal((await importDocument(ingester,'ghsa',partial)).unlinked,1);
          assert.deepEqual((await ingester.query('SELECT DISTINCT cve_id FROM cve.facets WHERE source_id=$1',[advisory.id])).rows,[{cve_id:'CVE-2099-71011'}]);
          assert.equal((await importDocument(ingester,'ghsa',{...partial,aliases:[],modified:'2099-06-03T00:00:00Z'})).unlinked,1);
          assert.equal((await ingester.query('SELECT count(*)::int n FROM cve.facets WHERE source_id=$1',[advisory.id])).rows[0].n,0);
          assert.equal((await ingester.query('SELECT count(*)::int n FROM cve.records WHERE source_id=$1',[advisory.id])).rows[0].n,0);
          assert.equal((await ingester.query('SELECT count(*)::int n FROM cve.observations WHERE source_id=$1',[advisory.id])).rows[0].n,3);
          assert.equal((await importDocument(ingester,'ghsa',advisory)).stale,1);
        } finally {
          if (ingester) {await ingester.end(); await Promise.all(closed);}
          await pool.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
        }
      });
    } finally {
      if (mcp) await mcp.close();
      if (server) {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
    }
  });
});
