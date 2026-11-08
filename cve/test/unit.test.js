'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {normalize, unpack, digest, date} = require('../normalize');
const {parseQuery, buildQuery, evidenceContext} = require('../query');
const {createDownloader, nvdWindow} = require('../sync');
const {baseURL, readContext} = require('../client');
const {options} = require('../cli');
const cve = require('./fixtures/cve5.json'), nvd = require('./fixtures/nvd.json'), ghsa = require('./fixtures/ghsa.json'), kev = require('./fixtures/kev.json');
test('CVE5 CNA + ADP references deduplicate while ranges, scores and languages survive', () => {
  const record = normalize('cvelist', cve)[0];
  assert.equal(record.cve_id, 'CVE-2099-10001'); assert.equal(record.descriptions.length, 2);
  assert.equal(record.references.length, 2); assert.deepEqual(record.references[0].tags, ['vendor-advisory','patch']);
  assert.equal(record.affected[0].versions[0].lessThan, '1.2.0'); assert.deepEqual(record.cwes, ['CWE-89']);
  assert.equal(record.metrics[0].cvssV3_1.baseScore, 7.5);
  assert.match(record.source_url, /2099\/10xxx\/CVE-2099-10001.json$/);
});
test('NVD configurations preserve AND/environment and CVSS discrepancies without verdicts', () => {
  const record = normalize('nvd', unpack('nvd', nvd)[0].raw)[0];
  assert.equal(record.modified, '2099-01-03T00:00:00.000Z'); assert.deepEqual(record.configurations, nvd.vulnerabilities[0].cve.configurations);
  assert.equal(record.cpe_matches.length, 2); assert.equal(record.affected.length, 1);
  assert.deepEqual(record.products, ['examplewidget']); assert.equal(record.metrics[0].cvssData.baseScore, 8.1);
  const escaped = structuredClone(nvd.vulnerabilities[0].cve);
  escaped.configurations[0].nodes[0].cpeMatch[0].criteria = 'cpe:2.3:a:ven\\:dor:prod\\:uct:*:*:*:*:*:*:*:*';
  assert.equal(normalize('nvd', escaped)[0].products[0], 'prod:uct');
});
test('GHSA aliases/ranges and KEV fields retain independent source identity', () => {
  const record = normalize('ghsa', ghsa)[0]; assert.equal(record.source_id, ghsa.id);
  assert.deepEqual(record.affected[0].ranges, ghsa.affected[0].ranges);
  assert.deepEqual(normalize('ghsa', {...ghsa, aliases: []}), []);
  assert.equal(normalize('ghsa', {...ghsa, withdrawn: ghsa.modified})[0].state, 'WITHDRAWN');
  const item = unpack('kev', kev)[0]; assert.equal(normalize('kev', item.raw, item)[0].kev.dueDate, '2099-02-01');
  assert.equal(normalize('circl', cve)[0].source_url, 'https://vulnerability.circl.lu/api/vulnerability/CVE-2099-10001');
});
test('unknown formats, IDs, states and dates fail explicitly; hashes ignore key order', () => {
  assert.throws(() => normalize('cvelist', {...cve, dataVersion: '4.0'}), /UNSUPPORTED/);
  assert.throws(() => normalize('circl', {id: 'x'}), /UNSUPPORTED/);
  assert.throws(() => normalize('cvelist', {...cve, cveMetadata: {...cve.cveMetadata, cveId: 'not-cve'}}), /INVALID_CVE_ID/);
  assert.throws(() => date('tomorrow'), /INVALID_SOURCE_DATE/);
  assert.throws(() => date('2024-02-30'), /INVALID_SOURCE_DATE/);
  assert.equal(digest({b: 1, a: {y: 2, x: 3}}), digest({a: {x: 3, y: 2}, b: 1}));
});
test('query rejects unknown/duplicate-shaped inputs and binds hostile strings as parameters', () => {
  for (const input of [{}, {id: 'CVE-1'}, {q: ['a','b']}, {q: 'x', limit: '51'}, {q: 'x', include_rejected: '1'}, {q: 'x', oops: 'x'}, {product: 'x', version: '\0'}, {q: 'x', version: '1.0'}]) assert.throws(() => parseQuery(input), /INVALID_QUERY/);
  const input = parseQuery({vendor: "x');DROP SCHEMA cve CASCADE;--", product: 'y', version: '1.1', limit: '2'});
  const sql = buildQuery(input); assert.ok(!sql.text.includes('DROP SCHEMA')); assert.ok(sql.values.includes(input.vendor));
  assert.equal(parseQuery({id: 'cve-2099-10001'}).id, 'CVE-2099-10001');
  assert.equal(evidenceContext({items: []}).untrusted_data, true);
});
test('NVD uses bounded windows; CLI flags and client destinations are strict', () => {
  assert.throws(() => nvdWindow('2024-01-01','2025-01-01'), /INVALID_NVD_WINDOW/);
  assert.throws(() => nvdWindow('2024-02-01','2024-01-01'), /INVALID_NVD_WINDOW/);
  assert.equal(nvdWindow('2024-01-01','2024-01-02').start, '2024-01-01T00:00:00.000Z');
  assert.deepEqual(options(['--source','nvd']), {source: 'nvd'});
  assert.throws(() => options(['--source','nvd','--source','kev']), /INVALID_ARGUMENTS/);
  for (const url of ['https://127.0.0.1','http://example.com','http://user:pass@127.0.0.1','http://127.0.0.1/x']) assert.throws(() => baseURL(url), /INVALID_CVE_BASE_URL/);
});
test('download rate limits NVD; retries transient errors without forwarding credentials to KEV', async () => {
  let now = 0; const waits = [], headers = []; let count = 0;
  const download = createDownloader({apiKey: 'synthetic-test-only', now: () => now, wait: async ms => {waits.push(ms); now += ms;}, fetchImpl: async (url, opts) => {
    headers.push(opts.headers);
    count++; return count === 1 ? new Response('', {status: 429, headers: {'retry-after': '2'}}) : Response.json({ok: true});
  }});
  assert.deepEqual(await download('https://services.nvd.nist.gov/rest/json/cves/2.0'), {ok: true});
  await download('https://services.nvd.nist.gov/rest/json/cves/2.0');
  await download('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json');
  assert.ok(waits.includes(2000)); assert.ok(waits.includes(650)); assert.equal(headers.at(-1).apiKey, undefined);
  await assert.rejects(() => download('https://attacker.invalid/'), /INVALID_SOURCE_URL/);
});
test('download bounds retries and fails closed on HTTP errors and malformed JSON', async () => {
  let count = 0;
  const download = createDownloader({wait: async () => {}, fetchImpl: async () => {count++; return new Response('', {status: 503});}});
  await assert.rejects(() => download('https://www.cisa.gov/x'), /SOURCE_RETRIES_EXHAUSTED/); assert.equal(count, 4);
  await assert.rejects(() => createDownloader({fetchImpl: async () => new Response('x')})('https://www.cisa.gov/x'), /SOURCE_INVALID_JSON/);
  await assert.rejects(() => createDownloader({fetchImpl: async () => new Response('', {status: 403})})('https://www.cisa.gov/x'), /SOURCE_HTTP_403/);
});
test('agent client returns explicit no-match and distinguishes output-budget failures', async () => {
  const response = evidenceContext({items: [], next_after: null});
  const result = await readContext({id: 'CVE-2099-99999'}, {fetchImpl: async () => Response.json(response)});
  assert.deepEqual(result.items, []);
  await assert.rejects(() => readContext({q: 'x'}, {fetchImpl: async () => new Response('', {status: 413})}), /OUTPUT_BUDGET_EXCEEDED/);
  await assert.rejects(() => readContext({q: 'x'}, {fetchImpl: async () => Response.json({items: []})}), /INVALID_CVE_RESPONSE/);
});
