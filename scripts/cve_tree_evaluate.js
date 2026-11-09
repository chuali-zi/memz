'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {performance} = require('node:perf_hooks');
const {temporaryDatabase} = require('../cve/test/temporary-db');
const {normalize, digest} = require('../cve/normalize');
const {createApp} = require('../cve/server');
const {buildTreeQuery, parseTreeQuery} = require('../cve/tree');
const {buildQuery, parseQuery} = require('../cve/query');
const fixture = require('../cve/test/fixtures/cve5.json');
const SIZE = 2000, ROUNDS = 20;
function percentile(samples, fraction) {
  const sorted = [...samples].sort((a, b) => a - b);
  return +sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)].toFixed(3);
}
async function seed(pool) {
  for (let offset = 0; offset < SIZE; offset += 100) {
    const batch = [];
    for (let i = offset; i < offset + 100; i++) {
      const raw = structuredClone(fixture);
      raw.cveMetadata.cveId = `CVE-2099-${7000000 + i}`;
      raw.containers = {cna: {...raw.containers.cna, title: 'SYNTHETIC tree measurement record',
        affected: [{vendor: 'SyntheticVendor', product: i % 20 === 0 ? 'nginx' : `synthetic-component-${i % 71}`}],
        problemTypes: [{descriptions: [{cweId: i % 40 === 0 ? 'CWE-22' : 'CWE-89'}]}]}};
      const normalized = normalize('cvelist', raw)[0];
      batch.push({source_id: normalized.source_id, cve_id: normalized.cve_id, source_url: normalized.source_url,
        source_modified: normalized.modified, sha256: digest(raw), raw, normalized});
    }
    // Bulk only the fixture load; use the production projection trigger and read queries.
    await pool.query(`WITH observations AS (
      INSERT INTO cve.observations(source,source_id,cve_id,source_url,source_modified,fetched_at,sha256,raw,normalized)
      SELECT 'cvelist',source_id,cve_id,source_url,source_modified,now(),sha256,raw,normalized
      FROM jsonb_to_recordset($1::jsonb) AS x(source_id text,cve_id text,source_url text,
        source_modified timestamptz,sha256 text,raw jsonb,normalized jsonb) RETURNING *
    ) INSERT INTO cve.records(source,source_id,cve_id,observation_id,normalized,last_seen)
      SELECT source,source_id,cve_id,id,normalized,fetched_at FROM observations`, [JSON.stringify(batch)]);
  }
  await pool.query('ANALYZE cve.records; ANALYZE cve.facets; ANALYZE cve.observations');
}
async function main() {
  const report = await temporaryDatabase(process.env.CVE_TEST_DATABASE_URL, async pool => {
    const role = `cve_measure_${crypto.randomBytes(8).toString('hex')}`;
    let connection, server;
    await seed(pool);
    await pool.query(`CREATE ROLE ${role} NOLOGIN`);
    try {
      await pool.query(`GRANT USAGE ON SCHEMA cve TO ${role}; GRANT SELECT ON cve.records,cve.observations,cve.facets TO ${role}`);
      connection = await pool.connect();
      await connection.query(`SET ROLE ${role}`);
      assert.equal((await connection.query('SELECT current_user AS name')).rows[0].name, role);
      // Deliberately serial: reuse a held reader connection and state this in the report.
      const reader = {connect: async () => ({query: (...args) => connection.query(...args), release() {}})};
      server = createApp(reader).listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      const get = async (route, query = {}) => {
        const response = await fetch(`${base}${route}?${new URLSearchParams(query)}`);
        assert.equal(response.status, 200);
        const body = await response.text();
        return {value: JSON.parse(body), bytes: Buffer.byteLength(body)};
      };
      const root = (await get('/api/cve/tree')).value;
      assert.equal(root.nodes.find(n => n.key === 'web').cve_count, 100);
      assert.equal(root.nodes.find(n => n.key === 'other').cve_count, 1900);
      const services = (await get('/api/cve/tree', {stack: 'web'})).value;
      assert.equal(services.nodes.length, 1);
      const service = services.nodes[0];
      const weaknesses = (await get('/api/cve/tree', service.next_query)).value;
      assert.deepEqual(weaknesses.nodes.map(n => [n.key, n.cve_count]), [['CWE-22', 50], ['CWE-89', 50]]);
      const query = {...weaknesses.nodes[0].context_query, limit: '10'};
      const context = (await get('/api/cve/context', query)).value;
      assert.equal(context.items.length, 10);
      assert.ok(context.items.every(item => (Number(item.cve_id.split('-')[2]) - 7000000) % 40 === 0));
      const cases = [
        {name: 'root_counts', route: '/api/cve/tree', query: {}, expected: root.nodes.map(n => n.key), shape: 'nodes'},
        {name: 'web_services', route: '/api/cve/tree', query: {stack: 'web'}, expected: [service.key], shape: 'nodes'},
        {name: 'service_weaknesses', route: '/api/cve/tree', query: service.next_query, expected: ['CWE-22','CWE-89'], shape: 'nodes'},
        {name: 'cwe_context', route: '/api/cve/context', query, expected: context.items.map(n => n.cve_id), shape: 'items'}
      ];
      const measurements = [];
      for (const entry of cases) {
        const elapsed = [], bytes = [];
        await get(entry.route, entry.query); // One explicit warmup for each case.
        for (let i = 0; i < ROUNDS; i++) {
          const start = performance.now(), result = await get(entry.route, entry.query);
          elapsed.push(+(performance.now() - start).toFixed(3)); bytes.push(result.bytes);
          assert.deepEqual(result.value[entry.shape].map(n => n.key || n.cve_id), entry.expected);
        }
        measurements.push({name: entry.name, passed: true, samples_ms: elapsed, p50_ms: percentile(elapsed, .5),
          p95_ms: percentile(elapsed, .95), max_output_bytes: Math.max(...bytes)});
      }
      const plans = {};
      for (const [name, sql] of [
        ['root_counts', buildTreeQuery(parseTreeQuery({}))],
        ['service_weaknesses', buildTreeQuery(parseTreeQuery(service.next_query))],
        ['cwe_context', buildQuery(parseQuery(query))]
      ]) plans[name] = (await connection.query({text: `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql.text}`, values: sql.values})).rows[0]['QUERY PLAN'];
      return {kind: 'synthetic_tree_http_measurement', generated_at: new Date().toISOString(), node: process.version,
        postgres: (await connection.query('SHOW server_version')).rows[0].server_version,
        environment: {platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, cpu_count: os.cpus().length},
        corpus: {cves: SIZE, source_records: SIZE, synthetic: true, web_cves: 100, other_cves: 1900},
        execution: {database_role: 'dedicated_select_only', concurrency: 1, held_reader_connections: 1, warmups_per_case: 1, measured_rounds_per_case: ROUNDS},
        passed: measurements.filter(m => m.passed).length, total: measurements.length, measurements, plans,
        limitations: 'Synthetic local warm-cache sequential HTTP baseline with one held read-only connection; not a full-CVE-corpus, pool-admission, concurrency, real-agent or semantic quality evaluation. Timings are observations, not an SLA.'};
    } finally {
      if (server) {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
      if (connection) {await connection.query('RESET ROLE'); connection.release();}
      await pool.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
    }
  });
  const sourceFiles = ['db/cve_schema.sql','cve/tree.js','cve/taxonomy.js','cve/query.js','cve/investigation.js','cve/server.js','cve/store.js','cve/normalize.js','scripts/cve_tree_evaluate.js'];
  report.source_sha256 = {};
  for (const file of sourceFiles) {
    // Hash LF-normalized source so Windows checkout line endings do not change identity.
    const source = (await fs.readFile(path.resolve(__dirname, '..', file), 'utf8')).replace(/\r\n/g, '\n');
    report.source_sha256[file] = crypto.createHash('sha256').update(source).digest('hex');
  }
  const directory = path.resolve(__dirname, '..', 'artifacts', 'cve');
  await fs.mkdir(directory, {recursive: true});
  await fs.writeFile(path.join(directory, 'tree-evaluation.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({passed: report.passed, total: report.total, corpus: report.corpus,
    measurements: report.measurements.map(({samples_ms, ...row}) => row), report: 'artifacts/cve/tree-evaluation.json'}, null, 2)}\n`);
}
if (require.main === module) main().catch(() => {process.stderr.write('CVE_TREE_EVALUATION_FAILED\n'); process.exitCode = 1;});
module.exports = {main};
