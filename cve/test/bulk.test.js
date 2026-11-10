'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {ingestCveBatch} = require('../bulk');
const {normalize,digest} = require('../normalize');
const fixture = require('./fixtures/cve5.json');
function entry(id) {
  const raw = structuredClone(fixture);
  raw.cveMetadata.cveId = id;
  return {raw,sourceURL:`https://example.invalid/pinned/${id}.json`};
}

test('bulk input validates the entire batch before issuing SQL', async () => {
  const client = {query:async () => assert.fail('invalid batch must not issue SQL')};
  for (const entries of [null,[],Array(501).fill(entry('CVE-2099-80001'))]) {
    await assert.rejects(() => ingestCveBatch(client,entries),/INVALID_CVE_BATCH_SIZE/);
  }
  await assert.rejects(() => ingestCveBatch(client,[entry('CVE-2099-80001'),entry('CVE-2099-80001')]),/DUPLICATE_CVE_BATCH_ID/);
  await assert.rejects(() => ingestCveBatch(client,[entry('CVE-2099-80001'),{raw:{}}]),/UNSUPPORTED_CVE_FORMAT/);
  await assert.rejects(() => ingestCveBatch(client,[null]),/INVALID_CVE_BATCH_ENTRY/);
  await assert.rejects(() => ingestCveBatch(client,[{...entry('CVE-2099-80001'),sourceURL:2}]),/INVALID_CVE_SOURCE_URL/);
  await assert.rejects(() => ingestCveBatch(client,[entry('CVE-2099-80001')],{fetchedAt:'wrong'}),/INVALID_SOURCE_DATE/);
});

test('500 changed documents use four SQL calls and preserve raw hashes and provenance', async () => {
  const entries = Array.from({length:500},(_,i) => entry(`CVE-2099-${80000+i}`));
  const calls = [];
  const client = {query:async (sql,values) => {calls.push({sql,values});return {rows:[]};}};
  const fetchedAt = '2099-03-01T00:00:00Z';
  assert.deepEqual(await ingestCveBatch(client,entries,{fetchedAt}),{inserted:500,updated:0,unchanged:0,stale:0,skipped:0});
  assert.equal(calls.length,4);
  assert.match(calls[0].sql,/ORDER BY lock_key COLLATE "C"/);
  assert.equal(calls[0].values[0][0],'cvelist:CVE-2099-80000:CVE-2099-80000');
  const stored = JSON.parse(calls[2].values[0]);
  assert.equal(stored.length,500);
  assert.equal(stored[0].sha256,digest(entries[0].raw));
  assert.deepEqual(stored[0].raw,entries[0].raw);
  assert.deepEqual(stored[0].normalized,normalize('cvelist',entries[0].raw)[0]);
  assert.equal(stored[0].source_url,entries[0].sourceURL);
  assert.equal(calls[2].values[1],'2099-03-01T00:00:00.000Z');
  assert.ok(calls.every(call => !/\b(?:BEGIN|COMMIT|ROLLBACK)\b/.test(call.sql)));
});

test('mixed classification uses at most five SQL calls and accepts timestamp-equal corrections', async () => {
  const entries = Array.from({length:5},(_,i) => entry(`CVE-2099-${81000+i}`));
  const old = entries.slice(0,4).map(({raw},i) => ({cve_id:raw.cveMetadata.cveId,
    sha256:i === 0 ? digest(raw) : 'a'.repeat(64),
    source_modified:new Date(i === 1 || i === 3 ? '2100-01-01' : raw.cveMetadata.dateUpdated)}));
  delete entries[3].raw.cveMetadata.dateUpdated;
  const calls = [];
  const client = {query:async (sql,values) => {calls.push({sql,values});return {rows:calls.length === 2 ? old : []};}};
  assert.deepEqual(await ingestCveBatch(client,entries),{inserted:1,updated:1,unchanged:1,stale:2,skipped:0});
  assert.equal(calls.length,5);
  assert.deepEqual(JSON.parse(calls[2].values[0]).map(row => row.cve_id),['CVE-2099-81002','CVE-2099-81004']);
  assert.deepEqual(calls[4].values[0],['CVE-2099-81000']);
  assert.ok(!calls[4].sql.includes('normalized='));
});
