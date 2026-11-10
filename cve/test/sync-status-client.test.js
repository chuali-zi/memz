'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const {Pool} = require('pg');
const {readSyncStatus, readCapabilities} = require('../client');
const {temporaryDatabase} = require('./temporary-db');
const {createApp} = require('../server');
const {transaction, checkpoint, importDocument} = require('../store');
const {CHECKPOINT} = require('../managed-sync');
const fixture = require('./fixtures/cve5.json');
const status = {schema: 'memz.cve.sync-status.v1', scope: 'CVE Program public records at a pinned commit',
  coverage: 'not_verified', completed: null, pending: null, records: [], runs: []};

test('sync status SDK accepts no parameters, uses local GET and validates response contract and budget', async () => {
  let calls = 0;
  const options = {url: 'http://127.0.0.1:3100', fetchImpl: async (url, init) => {
    calls++; assert.equal(url.href, 'http://127.0.0.1:3100/api/cve/sync-status');
    assert.equal(init.redirect, 'error'); assert.equal(init.method, undefined);
    return Response.json(status);
  }};
  assert.deepEqual(await readSyncStatus({}, options), status);
  assert.equal(calls, 1);
  for (const input of [null, [], 'status', {force: true}, {source: 'cvelist'}, {limit: 1}]) {
    await assert.rejects(readSyncStatus(input, options), /INVALID_QUERY/);
  }
  assert.equal(calls, 1);
  for (const value of [{...status, schema: 'wrong'}, {...status, coverage: 'complete'}, {...status, pending: []},
    {...status, completed: undefined}, {...status, records: {}}, {...status, runs: null}]) {
    await assert.rejects(readSyncStatus({}, {...options, fetchImpl: async () => Response.json(value)}), /INVALID_CVE_RESPONSE/);
  }
  await assert.rejects(readSyncStatus({}, {...options, fetchImpl: async () => Response.json({...status, guidance: 'x'.repeat(65536)})}), /OUTPUT_BUDGET_EXCEEDED/);
  await assert.rejects(readSyncStatus({}, {...options, fetchImpl: async () => new Response('', {status: 503})}), /CVE_SERVICE_UNAVAILABLE/);
});

test('sync status HTTP and MCP read unknown, pending and completed fixture states with SELECT-only privileges',
  {skip: !process.env.CVE_TEST_DATABASE_URL, timeout: 120000}, async t => {
    await temporaryDatabase(process.env.CVE_TEST_DATABASE_URL, async pool => {
      const role = `cve_status_reader_${crypto.randomBytes(8).toString('hex')}`;
      let reader, server, mcp;
      const connectionsClosed = [];
      await pool.query(`CREATE ROLE ${role} NOLOGIN`);
      try {
        await pool.query(`GRANT USAGE ON SCHEMA cve TO ${role}; GRANT SELECT ON cve.records,cve.facets,cve.checkpoints,cve.sync_runs TO ${role}`);
        reader = new Pool({connectionString: pool.options.connectionString, options: `-c role=${role}`, max: 2});
        reader.on('connect', client => connectionsClosed.push(new Promise(resolve => client.once('end', resolve))));
        assert.equal((await reader.query('SELECT current_user AS name')).rows[0].name, role);
        for (const table of ['records','facets','checkpoints','sync_runs']) {
          await assert.rejects(reader.query(`DELETE FROM cve.${table}`), error => error.code === '42501');
        }
        server = createApp(reader).listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
        const {StdioClientTransport} = require('@modelcontextprotocol/sdk/client/stdio.js');
        mcp = new Client({name: 'sync-status-fixture', version: '1.0.0'});
        await mcp.connect(new StdioClientTransport({command: process.execPath,
          args: [path.join(__dirname, '..', '..', 'scripts', 'cve_mcp.js')],
          env: {...process.env, CVE_BASE_URL: base}, stderr: 'pipe'}));
        const tools = (await mcp.listTools()).tools;
        assert.equal(tools.length, 5);
        const statusTool = tools.find(tool => tool.name === 'cve_sync_status');
        assert.deepEqual(statusTool.inputSchema, {type: 'object', properties: {}, additionalProperties: false});
        assert.equal(statusTool.annotations.readOnlyHint, true);
        assert.equal(statusTool.annotations.destructiveHint, false);
        const discovery = await readCapabilities({}, {url: base});
        assert.deepEqual(discovery.data_status.path, '/api/cve/sync-status');
        assert.equal(discovery.data_status.tool, 'cve_sync_status');
        assert.equal(discovery.workflow.length, 4);
        assert.equal(discovery.workflow.some(step => step.tool === 'cve_sync_status'), false);
        const call = async args => {
          const result = await mcp.callTool({name: 'cve_sync_status', ...(args === undefined ? {} : {arguments: args})});
          assert.equal(result.isError, false); return JSON.parse(result.content[0].text);
        };
        const persisted = async () => (await pool.query(`SELECT
          (SELECT jsonb_agg(to_jsonb(c) ORDER BY name) FROM cve.checkpoints c) checkpoints,
          (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM cve.sync_runs r) runs,
          (SELECT jsonb_agg(to_jsonb(r) ORDER BY cve_id) FROM cve.records r) records,
          (SELECT count(*)::int FROM cve.observations) observations`)).rows[0];
        const compareReads = async expected => {
          const before = await persisted();
          const direct = await readSyncStatus({}, {url: base});
          assert.equal(direct.coverage, expected);
          assert.deepEqual(await call({}), direct);
          assert.deepEqual(await call(), direct);
          assert.deepEqual(await persisted(), before);
          return direct;
        };
        await t.test('unknown coverage stays unverified even when status reads succeed', async () => {
          const value = await compareReads('not_verified');
          assert.equal(value.completed, null); assert.equal(value.pending, null);
          assert.deepEqual(value.records, []); assert.deepEqual(value.runs, []);
        });
        // These are explicit synthetic state fixtures, not assertions that a full upstream import ran.
        await importDocument(pool, 'cvelist', fixture);
        const pending = {mode: 'full', fromCommit: null, targetCommit: 'a'.repeat(40), inventoryHash: 'b'.repeat(64),
          total: 2, selected: 2, nextIndex: 1, counts: {inserted: 1, files: 1}, startedAt: '2099-01-01T00:00:00.000Z'};
        await transaction(pool, client => checkpoint(client, CHECKPOINT, {schema: 1, completed: null, pending}));
        await pool.query("INSERT INTO cve.sync_runs(source,status,counts,error_code) VALUES('cvelist','failed','{\"files\":1}','SOURCE_NETWORK_FAILED')");
        await t.test('pending partial import reports progress, existing local records and failed run honestly', async () => {
          const value = await compareReads('partial_update');
          assert.equal(value.pending.nextIndex, 1); assert.equal(value.pending.total, 2);
          assert.equal(value.completed, null); assert.equal(value.records[0].count, 1);
          assert.equal(value.runs[0].status, 'failed');
          assert.equal(value.runs[0].error_code, 'SOURCE_NETWORK_FAILED');
        });
        const completed = {verified: true, commit: 'a'.repeat(40), total: 1, inventoryHash: 'b'.repeat(64),
          completed_at: '2099-01-01T00:01:00.000Z', counts: {inserted: 1, files: 1}};
        await transaction(pool, client => checkpoint(client, CHECKPOINT, {schema: 1, completed, pending: null}));
        await t.test('completed checkpoint reports verification at completion time and exposes its fixed commit', async () => {
          const value = await compareReads('verified_at_last_completed_sync');
          assert.deepEqual(value.completed, completed); assert.equal(value.pending, null);
          assert.match(value.guidance, /manual imports can change current data/);
        });
        await transaction(pool, client => checkpoint(client, CHECKPOINT, {schema: 1, completed, pending}));
        await t.test('new pending update takes precedence over the earlier completed checkpoint', async () => {
          const value = await compareReads('partial_update');
          assert.deepEqual(value.completed, completed); assert.deepEqual(value.pending, pending);
        });
        await t.test('HTTP and MCP reject parameters and expose no synchronization write command', async () => {
          const before = await persisted();
          for (const query of ['?force=true', '?source=cvelist', '?source=cvelist&source=nvd']) {
            const response = await fetch(`${base}/api/cve/sync-status${query}`);
            assert.equal(response.status, 400); assert.deepEqual(await response.json(), {error: 'INVALID_QUERY'});
          }
          for (const method of ['POST','PUT','PATCH','DELETE']) {
            const response = await fetch(`${base}/api/cve/sync-status`, {method});
            assert.equal(response.status, 405); assert.deepEqual(await response.json(), {error: 'READ_ONLY'});
          }
          const response = await fetch(`${base}/api/cve/sync-status`);
          assert.equal(response.headers.get('cache-control'), 'no-store');
          assert.equal(response.status, 200);
          for (const args of [{force: true}, {source: 'cvelist'}, {limit: 1}]) {
            const result = await mcp.callTool({name: 'cve_sync_status', arguments: args});
            assert.equal(result.isError, true); assert.deepEqual(JSON.parse(result.content[0].text), {error: 'INVALID_QUERY'});
          }
          await assert.rejects(mcp.callTool({name: 'cve_sync_now', arguments: {}}), /INVALID_ARGUMENTS/);
          assert.deepEqual(await persisted(), before);
        });
      } finally {
        if (mcp) await mcp.close();
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        if (reader) { await reader.end(); await Promise.all(connectionsClosed); }
        await pool.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
      }
    });
  });
