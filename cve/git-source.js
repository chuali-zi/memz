'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFile, spawn} = require('node:child_process');
const {promisify} = require('node:util');
const {once} = require('node:events');
const execute = promisify(execFile);
const OFFICIAL_URL = 'https://github.com/CVEProject/cvelistV5.git';
const MARKER = '.memz-cve-source.json';
const OID = /^[a-f0-9]{40}$/;
const MAX_FILE = 64 * 1024 * 1024;

async function runGit(repo, args, {network = false} = {}) {
  try {
    return (await execute('git', ['--no-replace-objects', '-C', repo, ...args], {
      encoding: 'utf8', windowsHide: true, timeout: network ? 20 * 60000 : 120000,
      maxBuffer: 256 * 1024 * 1024,
      env: {...process.env, GIT_TERMINAL_PROMPT: '0'}
    })).stdout;
  } catch { throw new Error('SOURCE_GIT_FAILED'); }
}
async function noSymlinkAncestors(target) {
  let current = path.resolve(target);
  for (;;) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('SOURCE_SYMLINK_REFUSED'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
async function markerValue(repo) {
  try {
    const file = path.join(repo, MARKER), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error();
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (value.tool !== 'memz-cvelist-cache' || value.version !== 1 || value.remote !== OFFICIAL_URL) throw new Error();
  } catch { throw new Error('UNOWNED_SOURCE_CACHE'); }
}
// The caller holds the database source lock across cache preparation and import.
// gitRunner is an injectable process boundary for offline tests, never a CLI option.
async function prepareSourceInner(cacheRoot, {progress = () => {}, gitRunner = runGit, fetch: fetchEnabled = true} = {}) {
  if (!cacheRoot || typeof cacheRoot !== 'string') throw new Error('INVALID_SOURCE_CACHE');
  const repo = path.join(path.resolve(cacheRoot), 'cvelist.git');
  await noSymlinkAncestors(repo);
  if (!fetchEnabled) {
    try { if (!(await fs.lstat(repo)).isDirectory()) throw new Error(); }
    catch { throw new Error('SOURCE_CACHE_FETCH_REQUIRED'); }
  }
  if (fetchEnabled) {
    await fs.mkdir(path.dirname(repo), {recursive: true});
    try {
      await fs.mkdir(repo);
      await fs.writeFile(path.join(repo, MARKER), JSON.stringify({tool: 'memz-cvelist-cache', version: 1, remote: OFFICIAL_URL}), {flag: 'wx'});
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  await markerValue(repo);
  // A marked directory may be left behind by interruption before git init/remote add.
  let configured = false;
  try {
    const config = await fs.lstat(path.join(repo, 'config'));
    if (config.isSymbolicLink()) throw new Error('SOURCE_SYMLINK_REFUSED');
    configured = config.isFile();
  }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!configured) {
    if (!fetchEnabled) throw new Error('SOURCE_CACHE_FETCH_REQUIRED');
    await gitRunner(repo, ['init', '--bare']);
  }
  if ((await gitRunner(repo, ['rev-parse', '--is-bare-repository'])).trim() !== 'true') throw new Error('INVALID_SOURCE_CACHE');
  const remotes = (await gitRunner(repo, ['remote'])).trim();
  if (!remotes) {
    if (!fetchEnabled) throw new Error('SOURCE_CACHE_FETCH_REQUIRED');
    await gitRunner(repo, ['remote', 'add', 'origin', OFFICIAL_URL]);
  }
  else if (remotes !== 'origin') throw new Error('UNEXPECTED_SOURCE_REMOTE');
  const urls = (await gitRunner(repo, ['remote', 'get-url', '--all', 'origin'])).trim().split(/\r?\n/);
  if (urls.length !== 1 || urls[0] !== OFFICIAL_URL) throw new Error('UNEXPECTED_SOURCE_REMOTE');
  let previous;
  try { previous = (await gitRunner(repo, ['rev-parse', '--verify', 'refs/memz/upstream'])).trim(); }
  catch (error) { if (error.message !== 'SOURCE_GIT_FAILED') throw error; }
  if (previous && !OID.test(previous)) throw new Error('INVALID_SOURCE_COMMIT');
  if (!fetchEnabled) {
    if (!previous) throw new Error('SOURCE_CACHE_FETCH_REQUIRED');
    return {repo, commit: previous};
  }
  await progress({phase: 'fetching_source'});
  // Only this disposable candidate ref may be replaced. The trusted upstream
  // remains unchanged until ancestry succeeds and update-ref atomically publishes it.
  await gitRunner(repo, ['fetch', '--no-tags', ...(previous ? [] : ['--depth=1']), 'origin',
    '+refs/heads/main:refs/memz/candidate'], {network: true});
  const commit = (await gitRunner(repo, ['rev-parse', '--verify', 'refs/memz/candidate^{commit}'])).trim();
  if (!OID.test(commit)) throw new Error('INVALID_SOURCE_COMMIT');
  // Fetching into a non-head ref is not itself proof against an upstream rewrite.
  if (previous) await gitRunner(repo, ['merge-base', '--is-ancestor', previous, commit]);
  await gitRunner(repo, ['update-ref', 'refs/memz/upstream', commit, previous || '0'.repeat(40)]);
  await progress({phase: 'source_ready', commit});
  return {repo, commit};
}
async function prepareSource(cacheRoot, options = {}) {
  try { return await prepareSourceInner(cacheRoot, options); }
  catch (error) {
    if (/^[A-Z][A-Z_0-9]{0,63}$/.test(error.message)) throw error;
    throw new Error('SOURCE_CACHE_FAILED');
  }
}
function cvePath(file) {
  const match = /^cves\/(\d{4})\/(\d+xxx)\/(CVE-(\d{4})-(\d{4,}))\.json$/.exec(file);
  if (!match) return null;
  if (match[1] !== match[4] || match[2] !== `${match[5].slice(0, -3)}xxx`) throw new Error('INVALID_SOURCE_PATH');
  return match[3];
}
// UTF-8 JSON of [{path,oid,cveId}, ...], sorted by UTF-8 path bytes;
// object properties have exactly this order and no whitespace/newline.
function hashInventory(entries) {
  const ordered = entries.map(entry => ({path: entry.path, oid: entry.oid, cveId: entry.cveId}))
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return crypto.createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}
async function enumerateSource(repo, commit, {baseCommit} = {}) {
  if (!OID.test(commit) || (baseCommit && !OID.test(baseCommit))) throw new Error('INVALID_SOURCE_COMMIT');
  if (baseCommit) await runGit(repo, ['merge-base', '--is-ancestor', baseCommit, commit]);
  const tree = await runGit(repo, ['ls-tree', '-r', '-z', '--full-tree', commit, '--', 'cves']);
  const entries = [], seen = new Set();
  for (const line of tree.split('\0')) {
    if (!line) continue;
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40})\t(.+)$/.exec(line);
    if (!match) throw new Error('INVALID_SOURCE_TREE');
    const cveId = cvePath(match[4]);
    if (!cveId) continue;
    if (match[1] !== '100644' || match[2] !== 'blob') throw new Error('SOURCE_SYMLINK_REFUSED');
    if (seen.has(cveId)) throw new Error('DUPLICATE_SOURCE_CVE');
    seen.add(cveId); entries.push({path: match[4], oid: match[3], cveId});
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  if (!entries.length) throw new Error('NO_SOURCE_FILES');
  const inventoryHash = hashInventory(entries);
  if (!baseCommit) return {entries, inventoryHash, total: entries.length, deleted: []};
  const diff = (await runGit(repo, ['diff', '--no-renames', '--name-status', '-z', '--diff-filter=ACMTD', baseCommit, commit, '--', 'cves'])).split('\0');
  if (diff.at(-1) === '') diff.pop();
  const changed = new Set(), deleted = [];
  if (diff.length % 2) throw new Error('INVALID_SOURCE_DIFF');
  for (let i = 0; i < diff.length; i += 2) {
    if (!/^[ACMTD]$/.test(diff[i])) throw new Error('INVALID_SOURCE_DIFF');
    if (!cvePath(diff[i + 1])) continue;
    if (diff[i] === 'D') deleted.push(diff[i + 1]); else changed.add(diff[i + 1]);
  }
  deleted.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return {entries: entries.filter(entry => changed.has(entry.path)), inventoryHash, total: entries.length, deleted};
}
class PipeReader {
  constructor(stream) { this.iterator = stream[Symbol.asyncIterator](); this.buffer = Buffer.alloc(0); this.offset = 0; }
  async available() {
    if (this.offset < this.buffer.length) return;
    const next = await this.iterator.next();
    if (next.done) throw new Error('SOURCE_GIT_FAILED');
    this.buffer = next.value; this.offset = 0;
  }
  async line() {
    const chunks = []; let length = 0;
    for (;;) {
      await this.available();
      const end = this.buffer.indexOf(10, this.offset), stop = end < 0 ? this.buffer.length : end;
      const part = this.buffer.subarray(this.offset, stop); length += part.length;
      if (length > 256) throw new Error('INVALID_SOURCE_OBJECT');
      chunks.push(part); this.offset = stop + (end < 0 ? 0 : 1);
      if (end >= 0) return Buffer.concat(chunks).toString('ascii');
    }
  }
  async bytes(size) {
    const result = Buffer.allocUnsafe(size); let written = 0;
    while (written < size) {
      await this.available();
      const count = Math.min(size - written, this.buffer.length - this.offset);
      this.buffer.copy(result, written, this.offset, this.offset + count);
      written += count; this.offset += count;
    }
    return result;
  }
}
async function* readSourceEntries(repo, entries) {
  const child = spawn('git', ['--no-replace-objects', '-C', repo, 'cat-file', '--batch'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, GIT_TERMINAL_PROMPT: '0'}
  });
  let processError, closed = false, timer;
  child.on('error', () => { processError = new Error('SOURCE_GIT_FAILED'); });
  child.stdin.on('error', () => { processError = new Error('SOURCE_GIT_FAILED'); });
  child.stderr.resume();
  const completion = new Promise(resolve => child.once('close', code => { closed = true; resolve(code); }));
  const reader = new PipeReader(child.stdout);
  try {
    for (const entry of entries) {
      if (!entry || !OID.test(entry.oid) || !cvePath(entry.path) || cvePath(entry.path) !== entry.cveId) throw new Error('INVALID_SOURCE_ENTRY');
      timer = setTimeout(() => { processError = new Error('SOURCE_GIT_FAILED'); child.kill(); }, 120000); timer.unref();
      if (processError) throw processError;
      if (!child.stdin.write(`${entry.oid}\n`)) await once(child.stdin, 'drain');
      const header = /^([a-f0-9]{40}) blob (0|[1-9]\d*)$/.exec(await reader.line());
      if (!header || header[1] !== entry.oid) throw new Error('INVALID_SOURCE_OBJECT');
      const size = Number(header[2]);
      if (!Number.isSafeInteger(size) || size > MAX_FILE) throw new Error('SOURCE_TOO_LARGE');
      const data = await reader.bytes(size);
      if ((await reader.bytes(1))[0] !== 10) throw new Error('INVALID_SOURCE_OBJECT');
      let raw; try { raw = JSON.parse(data.toString('utf8')); } catch { throw new Error('INVALID_SOURCE_FILE'); }
      if (!raw || raw.cveMetadata?.cveId !== entry.cveId) throw new Error('SOURCE_CVE_ID_MISMATCH');
      clearTimeout(timer); timer = undefined;
      yield {entry, raw};
    }
    child.stdin.end();
    if (await completion !== 0 || processError) throw new Error('SOURCE_GIT_FAILED');
  } catch (error) {
    if (/^[A-Z][A-Z_0-9]{0,63}$/.test(error.message)) throw error;
    throw new Error('SOURCE_GIT_FAILED');
  } finally {
    clearTimeout(timer);
    if (!closed) {
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.kill();
    }
    await completion;
  }
}
module.exports = {prepareSource, enumerateSource, readSourceEntries, hashInventory};
