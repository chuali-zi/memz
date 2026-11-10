'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const exec = promisify(execFile);
const {prepareSource, enumerateSource, readSourceEntries, hashInventory} = require('../git-source');
const official = 'https://github.com/CVEProject/cvelistV5.git';
const marker = JSON.stringify({tool: 'memz-cvelist-cache', version: 1, remote: official});
const p1 = 'cves/2099/10xxx/CVE-2099-10001.json';
const p2 = 'cves/2099/20xxx/CVE-2099-20001.json';
async function git(repo, args) {
  return (await exec('git', ['-C', repo, ...(args[0] === 'init' ? [] : ['--git-dir', repo, '--work-tree', repo]), ...args], {windowsHide: true, env: {...process.env,
    GIT_AUTHOR_NAME: 'Synthetic fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Synthetic fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid'}})).stdout.trim();
}
async function fixture(t) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'memz-cve-git-'));
  t.after(() => fs.rm(repo, {recursive: true, force: true}));
  await git(repo, ['init', '--bare']);
  return repo;
}
async function write(repo, file, value) {
  await fs.mkdir(path.dirname(path.join(repo, file)), {recursive: true});
  await fs.writeFile(path.join(repo, file), typeof value === 'string' ? value : JSON.stringify(value));
}
async function commit(repo) { await git(repo, ['add', '-A', '--', 'cves']); await git(repo, ['commit', '-m', 'synthetic fixture']); return git(repo, ['rev-parse', 'HEAD']); }
function raw(id, extra = '') { return {dataType: 'CVE_RECORD', dataVersion: '5.2', cveMetadata: {cveId: id, state: 'PUBLISHED'}, extra}; }
async function collect(repo, entries) { const found = []; for await (const value of readSourceEntries(repo, entries)) found.push(value); return found; }

test('pinned inventory and batch reader ignore dirty worktree, preserve large/Unicode JSON and stable hashes', async t => {
  const repo = await fixture(t);
  await write(repo, p2, raw('CVE-2099-20001', '来源证据'.repeat(60000)));
  await write(repo, p1, raw('CVE-2099-10001'));
  await write(repo, 'cves/delta.json', {ignored: true});
  const head = await commit(repo);
  await write(repo, p1, raw('CVE-2099-99999'));
  const all = await enumerateSource(repo, head);
  assert.equal(all.total, 2); assert.deepEqual(all.entries.map(e => e.path), [p1, p2]);
  assert.equal(all.inventoryHash, hashInventory([...all.entries].reverse()));
  assert.equal(all.inventoryHash, hashInventory(all.entries.map(e => ({cveId: e.cveId, oid: e.oid, path: e.path, ignored: 1}))));
  const found = await collect(repo, all.entries);
  assert.equal(found[0].raw.cveMetadata.cveId, 'CVE-2099-10001');
  assert.equal(found[1].raw.extra, '来源证据'.repeat(60000));
  // Consumer cancellation closes the long-lived child and a following reader still works.
  for await (const value of readSourceEntries(repo, all.entries)) { assert.equal(value.entry.path, p1); break; }
  assert.equal((await collect(repo, all.entries)).length, 2);
});

test('incremental inventory keeps whole-target count/hash and explicitly reports deletions and ancestry gaps', async t => {
  const repo = await fixture(t);
  await write(repo, p1, raw('CVE-2099-10001')); const base = await commit(repo);
  await write(repo, p2, raw('CVE-2099-20001')); const head = await commit(repo);
  const delta = await enumerateSource(repo, head, {baseCommit: base});
  assert.equal(delta.total, 2); assert.deepEqual(delta.entries.map(e => e.path), [p2]);
  assert.equal(delta.inventoryHash, (await enumerateSource(repo, head)).inventoryHash);
  const same = await enumerateSource(repo, head, {baseCommit: head});
  assert.equal(same.entries.length, 0); assert.equal(same.total, 2);
  await fs.unlink(path.join(repo, p1)); const removed = await commit(repo);
  assert.deepEqual((await enumerateSource(repo, removed, {baseCommit: head})).deleted, [p1]);
  await assert.rejects(enumerateSource(repo, base, {baseCommit: removed}), /SOURCE_GIT_FAILED/);
});

test('CVE blobs reject invalid JSON, ID mismatches, missing objects and untrusted entry paths', async t => {
  const repo = await fixture(t);
  await write(repo, p1, '{broken'); let head = await commit(repo);
  let inventory = await enumerateSource(repo, head);
  await assert.rejects(collect(repo, inventory.entries), /INVALID_SOURCE_FILE/);
  await write(repo, p1, raw('CVE-2099-10002')); head = await commit(repo);
  inventory = await enumerateSource(repo, head);
  await assert.rejects(collect(repo, inventory.entries), /SOURCE_CVE_ID_MISMATCH/);
  await assert.rejects(collect(repo, [{...inventory.entries[0], oid: '0'.repeat(40)}]), /INVALID_SOURCE_OBJECT/);
  await assert.rejects(collect(repo, [{...inventory.entries[0], path: '../CVE-2099-10001.json'}]), /INVALID_SOURCE_ENTRY/);
  await assert.rejects(collect(repo, [{...inventory.entries[0], path: '../file.json', cveId: null}]), /INVALID_SOURCE_ENTRY/);
  await assert.rejects(enumerateSource(repo, '--all'), /INVALID_SOURCE_COMMIT/);
});

test('git symlink mode and inconsistent CVE bucket paths are refused', async t => {
  const repo = await fixture(t);
  await write(repo, p1, raw('CVE-2099-10001')); await commit(repo);
  const oid = await git(repo, ['rev-parse', `HEAD:${p1}`]);
  await git(repo, ['update-index', '--cacheinfo', `120000,${oid},${p1}`]);
  await git(repo, ['commit', '-m', 'synthetic symbolic link mode']);
  await assert.rejects(enumerateSource(repo, await git(repo, ['rev-parse', 'HEAD'])), /SOURCE_SYMLINK_REFUSED/);
  // Restore from a committed regular blob and add an invalid bucket without filesystem symlinks.
  await git(repo, ['update-index', '--cacheinfo', `100644,${oid},${p1}`]);
  await write(repo, 'cves/2099/99xxx/CVE-2099-10001.json', raw('CVE-2099-10001'));
  const head = await commit(repo);
  await assert.rejects(enumerateSource(repo, head), /INVALID_SOURCE_PATH/);
});

test('prepare cache refuses unrelated repositories and offline misses without creating directories', async t => {
  const root = await fixture(t);
  await assert.rejects(prepareSource(path.join(root, 'absent'), {fetch: false}), /SOURCE_CACHE_FETCH_REQUIRED/);
  await assert.rejects(fs.stat(path.join(root, 'absent')), {code: 'ENOENT'});
  await fs.mkdir(path.join(root, 'cvelist.git'));
  await assert.rejects(prepareSource(root), /UNOWNED_SOURCE_CACHE/);
});

test('oversized blobs are rejected before reading their payload', async t => {
  const repo = await fixture(t);
  await write(repo, p1, raw('CVE-2099-10001')); const head = await commit(repo);
  const entry = (await enumerateSource(repo, head)).entries[0];
  const large = path.join(repo, 'oversized.fixture'), handle = await fs.open(large, 'w');
  try { await handle.truncate(64 * 1024 * 1024 + 1); } finally { await handle.close(); }
  const oid = await git(repo, ['hash-object', '-w', '--', large]);
  await assert.rejects(collect(repo, [{...entry, oid}]), /SOURCE_TOO_LARGE/);
});

test('owned cache resumes initialization, fetches shallow only once and supports offline continuation', async t => {
  const root = await fixture(t), repo = path.join(root, 'cvelist.git'), calls = [], phases = [];
  await fs.mkdir(repo); await fs.writeFile(path.join(repo, '.memz-cve-source.json'), marker);
  let initialized = false, remote = false, fetched = false;
  const sha = 'a'.repeat(40);
  const runner = async (location, args) => {
    assert.equal(location, repo); calls.push(args);
    if (args[0] === 'init') { initialized = true; await fs.writeFile(path.join(repo, 'config'), '[core]\n bare = true\n'); return ''; }
    if (args[0] === 'rev-parse' && args[1] === '--is-bare-repository') return initialized ? 'true\n' : 'false\n';
    if (args[0] === 'remote' && args.length === 1) return remote ? 'origin\n' : '';
    if (args[0] === 'remote' && args[1] === 'add') { remote = true; return ''; }
    if (args[0] === 'remote' && args[1] === 'get-url') return `${official}\n`;
    if (args[0] === 'rev-parse') { if (!fetched) throw new Error('SOURCE_GIT_FAILED'); return `${sha}\n`; }
    if (args[0] === 'fetch') { fetched = true; return ''; }
    if (args[0] === 'merge-base') return '';
    if (args[0] === 'update-ref') return '';
    throw new Error('Unexpected fixture command');
  };
  assert.deepEqual(await prepareSource(root, {gitRunner: runner, progress: p => phases.push(p.phase)}), {repo, commit: sha});
  assert.equal(calls.find(args => args[0] === 'fetch').includes('--depth=1'), true);
  assert.equal(calls.find(args => args[0] === 'fetch').at(-1), '+refs/heads/main:refs/memz/candidate');
  assert.deepEqual(calls.find(args => args[0] === 'update-ref'), ['update-ref','refs/memz/upstream',sha,'0'.repeat(40)]);
  calls.length = 0;
  await prepareSource(root, {gitRunner: runner});
  assert.equal(calls.find(args => args[0] === 'fetch').includes('--depth=1'), false);
  assert.deepEqual(calls.find(args => args[0] === 'update-ref'), ['update-ref','refs/memz/upstream',sha,sha]);
  calls.length = 0;
  assert.equal((await prepareSource(root, {fetch: false, gitRunner: runner})).commit, sha);
  assert.equal(calls.some(args => ['init', 'fetch'].includes(args[0])), false);
  assert.deepEqual(phases, ['fetching_source', 'source_ready']);
  await assert.rejects(prepareSource(root, {gitRunner: async (location, args) => args[0] === 'rev-parse' ? 'true' : args.length === 1 ? 'origin' : 'https://example.invalid/untrusted.git'}), /UNEXPECTED_SOURCE_REMOTE/);
});

test('unrelated fetched candidate never changes the trusted ref; validated descendants publish atomically', async t => {
  const root = await fixture(t), repo = path.join(root, 'cvelist.git');
  await fs.mkdir(repo); await git(repo, ['init','--bare']);
  await fs.writeFile(path.join(repo, '.memz-cve-source.json'), marker);
  await git(repo, ['remote','add','origin',official]);
  await write(repo, p1, raw('CVE-2099-10001')); const previous = await commit(repo);
  await git(repo, ['update-ref','refs/memz/upstream',previous]);
  const unrelated = await git(repo, ['commit-tree',`${previous}^{tree}`,'-m','independent synthetic root']);
  let candidate = unrelated;
  const runner = async (location, args) => {
    // Replaces only the network boundary: all ref, ancestry and atomic publication
    // commands below are executed by real Git against this isolated bare fixture.
    if (args[0] === 'fetch') {
      assert.equal(args.at(-1), '+refs/heads/main:refs/memz/candidate');
      await git(location, ['update-ref','refs/memz/candidate',candidate]); return '';
    }
    try { return (await exec('git', ['-C',location,...args], {windowsHide:true})).stdout; }
    catch { throw new Error('SOURCE_GIT_FAILED'); }
  };
  await assert.rejects(prepareSource(root, {gitRunner:runner}), /SOURCE_GIT_FAILED/);
  assert.equal(await git(repo, ['rev-parse','refs/memz/upstream']), previous);
  assert.equal(await git(repo, ['rev-parse','refs/memz/candidate']), unrelated);
  assert.equal((await prepareSource(root, {fetch:false})).commit, previous);
  // Repeating the failure remains safe and cannot adopt the rejected candidate.
  await assert.rejects(prepareSource(root, {gitRunner:runner}), /SOURCE_GIT_FAILED/);
  assert.equal(await git(repo, ['rev-parse','refs/memz/upstream']), previous);
  await write(repo, p2, raw('CVE-2099-20001')); candidate = await commit(repo);
  assert.equal((await prepareSource(root, {gitRunner:runner})).commit, candidate);
  assert.equal(await git(repo, ['rev-parse','refs/memz/upstream']), candidate);
});
