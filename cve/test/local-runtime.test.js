'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {ensureLocalConfig, loadLocalConfig, assertSafePath, safeErrorCode, locations} = require('../../scripts/cve_local');
async function temporary(t) {
  const parent = path.join(__dirname, '../../artifacts/cve/runtime-tests');
  await fs.mkdir(parent, {recursive: true});
  const root = await fs.mkdtemp(path.join(parent, 'memz-cve-runtime-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return root;
}
test('local config creates strong separated credentials and reruns preserve them', async t => {
  const root = await temporary(t), first = await ensureLocalConfig({root}), paths = locations(root);
  assert.equal(first.created, true);
  const original = await fs.readFile(paths.configFile, 'utf8'), config = JSON.parse(original);
  const passwords = Object.values(config.credentials).map(value => value.password);
  assert.equal(new Set(passwords).size, 3);
  for (const value of passwords) {
    assert.match(value, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(first).includes(value), false);
  }
  assert.equal((await ensureLocalConfig({root})).created, false);
  assert.equal(await fs.readFile(paths.configFile, 'utf8'), original);
  for (const role of ['reader', 'ingester', 'owner']) {
    const loaded = await loadLocalConfig({role, root}), url = new URL(loaded.databaseUrl);
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '5433');
    assert.equal(url.pathname, '/memz_cve'); assert.equal(url.username, `memz_cve_${role}`);
    assert.equal(loaded.dataDir, path.join(root, 'data', 'cve', 'postgres'));
  }
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(paths.runtimeDir)).mode & 0o077, 0);
    assert.equal((await fs.stat(paths.configFile)).mode & 0o077, 0);
    assert.equal((await fs.stat(paths.passwordFile)).mode & 0o077, 0);
  }
  await assert.rejects(loadLocalConfig({root}), /CVE_LOCAL_INVALID_ARGUMENTS/);
  await assert.rejects(loadLocalConfig({root, role: 'postgres'}), /CVE_LOCAL_INVALID_ARGUMENTS/);
  await fs.writeFile(paths.passwordFile, 'mismatch');
  await assert.rejects(ensureLocalConfig({root}), /CVE_LOCAL_CONFIG_INVALID/);
  assert.equal(await fs.readFile(paths.configFile, 'utf8'), original);
});
test('runtime refuses preexisting unmanaged data or partial credentials', async t => {
  const root = await temporary(t), paths = locations(root);
  await fs.mkdir(paths.dataDir, {recursive: true});
  await fs.writeFile(path.join(paths.dataDir, 'PG_VERSION'), '16');
  await assert.rejects(ensureLocalConfig({root}), /CVE_LOCAL_UNMANAGED_DATA/);
  assert.equal(await fs.readFile(path.join(paths.dataDir, 'PG_VERSION'), 'utf8'), '16');
  await fs.mkdir(paths.runtimeDir, {recursive: true});
  await fs.writeFile(paths.passwordFile, 'preexisting-secret');
  await assert.rejects(ensureLocalConfig({root}), /CVE_LOCAL_UNMANAGED_DATA/);
  assert.equal(await fs.readFile(paths.passwordFile, 'utf8'), 'preexisting-secret');
});
test('path guards reject escapes, linked directories and hardlinked secrets', async t => {
  const root = await temporary(t), outside = await temporary(t);
  await assert.rejects(assertSafePath(root, path.join(root, '..', 'escape')), /CVE_LOCAL_PATH_UNSAFE/);
  await fs.symlink(outside, path.join(root, 'data'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(ensureLocalConfig({root}), /CVE_LOCAL_PATH_UNSAFE/);
  await fs.unlink(path.join(root, 'data'));
  await fs.writeFile(path.join(root, 'a'), 'secret');
  await fs.link(path.join(root, 'a'), path.join(root, 'b'));
  await assert.rejects(assertSafePath(root, path.join(root, 'a'), {file: true}), /CVE_LOCAL_PATH_UNSAFE/);
});
test('runtime errors and invalid command output never expose arbitrary detail', () => {
  const sensitive = 'postgresql://admin:secret-password@127.0.0.1/database';
  assert.equal(safeErrorCode(new Error(sensitive)), 'CVE_LOCAL_COMMAND_FAILED');
  assert.equal(safeErrorCode(new Error('CVE_LOCAL_ROLE_MISMATCH')), 'CVE_LOCAL_ROLE_MISMATCH');
  assert.equal(safeErrorCode(new Error('SECRET_TOKEN_EXAMPLE')), 'CVE_LOCAL_COMMAND_FAILED');
  const result = spawnSync(process.execPath, [path.join(__dirname, '../../scripts/cve_local.js'), sensitive], {encoding: 'utf8', windowsHide: true});
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'CVE_LOCAL_INVALID_ARGUMENTS\n');
});
test('compose keeps PG16 on loopback with project-local durable storage and file secret', async () => {
  const compose = await fs.readFile(path.join(__dirname, '../../compose.cve.yml'), 'utf8');
  assert.match(compose, /^name: memz-cve$/m);
  assert.match(compose, /image: postgres:16/);
  assert.match(compose, /"127\.0\.0\.1:5433:5432"/);
  assert.match(compose, /source: \.\/data\/cve\/postgres\s+target: \/var\/lib\/postgresql\/data/);
  assert.match(compose, /source: \.\/data\/cve\/runtime\/owner\.password/);
  assert.match(compose, /POSTGRES_PASSWORD_FILE: \/run\/secrets\/cve_owner_password/);
  assert.doesNotMatch(compose, /POSTGRES_PASSWORD:|5432:5432|shujuku|memz_app|node_modules|external:/);
});
