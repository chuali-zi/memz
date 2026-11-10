'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const exec = promisify(execFile);
const {transaction, ingest, checkpoint, getCheckpoint, runTracked, addCounts, importDocument} = require('./store');
const {unpack, date} = require('./normalize');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const DAY = 86400000;
function createDownloader({fetchImpl = fetch, wait = pause, apiKey = process.env.NVD_API_KEY, now = Date.now} = {}) {
  let lastNvd = -Infinity;
  return async function download(url) {
    const u = new URL(url), nvd = u.hostname === 'services.nvd.nist.gov';
    const rawGit = u.hostname === 'raw.githubusercontent.com' && /^\/(?:CVEProject\/cvelistV5|github\/advisory-database)\/[a-f0-9]{40,64}\//.test(u.pathname);
    if (u.protocol !== 'https:' || u.username || u.password || (!rawGit && !['services.nvd.nist.gov','www.cisa.gov','vulnerability.circl.lu'].includes(u.hostname))) throw new Error('INVALID_SOURCE_URL');
    for (let attempt = 0; attempt < 4; attempt++) {
      if (nvd) {
        const delay = (apiKey ? 650 : 6500) - (now() - lastNvd);
        if (delay > 0) await wait(delay);
        lastNvd = now();
      }
      let response;
      try {
        response = await fetchImpl(url, {redirect: 'error', signal: AbortSignal.timeout(30000),
          headers: {Accept: 'application/json', ...(nvd && apiKey ? {apiKey} : {})}});
      } catch {
        if (attempt === 3) throw new Error('SOURCE_NETWORK_FAILED');
        await wait(1000 * 2 ** attempt); continue;
      }
      if (response.status === 429 || response.status >= 500) {
        const retry = response.headers.get('retry-after');
        await response.body?.cancel();
        if (attempt === 3) throw new Error('SOURCE_RETRIES_EXHAUSTED');
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry || '') - now();
        await wait(Math.min(60000, Math.max(1000 * 2 ** attempt, Number.isFinite(seconds) ? seconds : 0))); continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`SOURCE_HTTP_${response.status}`); }
      const chunks = []; let size = 0;
      try {
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > 64 * 1024 * 1024) throw new Error('SOURCE_TOO_LARGE');
          chunks.push(chunk);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (error) { throw new Error(error.message === 'SOURCE_TOO_LARGE' ? 'SOURCE_TOO_LARGE' : 'SOURCE_INVALID_JSON'); }
    }
  };
}
async function withSyncLock(pool, source, fn) {
  const lock = await pool.connect();
  try {
    const acquired = (await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok', [`cve-sync:${source}`])).rows[0].ok;
    if (!acquired) throw new Error('SYNC_BUSY');
    try {
      // Holding the source lock proves earlier running entries have no active
      // conforming writer (e.g. a process was interrupted before its catch ran).
      await pool.query("UPDATE cve.sync_runs SET status='failed',finished_at=now(),error_code='SYNC_INTERRUPTED' WHERE source=$1 AND status='running'", [source]);
      return await runTracked(pool, source, fn);
    }
    finally { await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`cve-sync:${source}`]); }
  } finally { lock.release(); }
}
function nvdWindow(start, end) {
  const from = date(start), to = date(end);
  if (!from || !to || new Date(to) <= new Date(from) || new Date(to) - new Date(from) > 120 * DAY) throw new Error('INVALID_NVD_WINDOW');
  return {start: from, end: to};
}
async function syncNvd(pool, {start, end, download = createDownloader()} = {}) {
  return withSyncLock(pool, 'nvd', async counts => {
    let cursor = await getCheckpoint(pool, 'nvd');
    const explicit = start !== undefined || end !== undefined;
    if (explicit && (!start || !end)) throw new Error('INVALID_NVD_WINDOW');
    const window = explicit ? nvdWindow(start, end) : cursor?.pending || (cursor?.completed_end ? nvdWindow(new Date(new Date(cursor.completed_end) - 2 * 60000).toISOString(), new Date(Math.min(Date.now(), new Date(cursor.completed_end).getTime() + 119 * DAY)).toISOString()) : null);
    if (!window) throw new Error('NVD_INITIAL_WINDOW_REQUIRED');
    if (cursor?.pending && (window.start !== cursor.pending.start || window.end !== cursor.pending.end)) throw new Error('NVD_PENDING_WINDOW_MISMATCH');
    if (cursor?.completed_end && explicit && new Date(window.start) > new Date(cursor.completed_end)) throw new Error('NVD_CHECKPOINT_GAP');
    let index = cursor?.pending?.start === window.start && cursor?.pending?.end === window.end ? cursor.next_index : 0;
    const completed = cursor?.completed_end;
    for (;;) {
      const url = new URL('https://services.nvd.nist.gov/rest/json/cves/2.0');
      for (const [key, value] of Object.entries({lastModStartDate: window.start, lastModEndDate: window.end, startIndex: index, resultsPerPage: 2000})) url.searchParams.set(key, value);
      const data = await download(url.href);
      if (!Number.isSafeInteger(data.totalResults) || data.totalResults < 0 || data.startIndex !== index || !Array.isArray(data.vulnerabilities) || data.vulnerabilities.length > 2000) throw new Error('INVALID_NVD_PAGE');
      if (data.vulnerabilities.length === 0 && index < data.totalResults) throw new Error('EMPTY_NVD_PAGE');
      const next = index + data.vulnerabilities.length, done = next >= data.totalResults;
      if (next > data.totalResults) throw new Error('INVALID_NVD_PAGE');
      await transaction(pool, async client => {
        const pageCounts = {};
        for (const item of data.vulnerabilities) addCounts(pageCounts, await ingest(client, 'nvd', item.cve || item));
        cursor = done ? {completed_end: completed && completed > window.end ? completed : window.end} : {completed_end: completed || null, pending: window, next_index: next};
        await checkpoint(client, 'nvd', cursor);
        // Counts are added only after COMMIT below.
        return pageCounts;
      }).then(value => addCounts(counts, value));
      counts.pages = (counts.pages || 0) + 1;
      if (done) break;
      index = next;
    }
  });
}
async function git(repo, args) {
  try { return (await exec('git', ['-C', repo, ...args], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true})).stdout; }
  catch { throw new Error('SOURCE_GIT_FAILED'); }
}
async function syncGit(pool, source, repo) {
  if (!['cvelist', 'ghsa'].includes(source) || !repo) throw new Error('INVALID_GIT_SOURCE');
  repo = path.resolve(repo);
  return withSyncLock(pool, source, async counts => {
    const expected = source === 'cvelist' ? 'CVEProject/cvelistV5' : 'github/advisory-database';
    const remote = (await git(repo, ['remote', 'get-url', 'origin'])).trim().replace(/\.git$/, '');
    if (![ `https://github.com/${expected}`, `git@github.com:${expected}` ].includes(remote)) throw new Error('UNEXPECTED_SOURCE_REMOTE');
    const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error('INVALID_SOURCE_COMMIT');
    const previous = await getCheckpoint(pool, `git:${source}`);
    if (previous?.commit === head) { counts.unchanged_snapshot = 1; return; }
    if (previous?.commit) {
      // Refuse rewritten/missing history; never silently skip a gap.
      await git(repo, ['merge-base', '--is-ancestor', previous.commit, head]);
      const removed = await git(repo, ['diff', '--no-renames', '--name-only', '--diff-filter=D', previous.commit, head, '--', source === 'cvelist' ? 'cves' : 'advisories']);
      if (removed.trim()) throw new Error('SOURCE_DELETIONS_REQUIRE_REVIEW');
    }
    const paths = (await git(repo, previous?.commit ? ['diff', '--no-renames', '--name-only', '--diff-filter=ACMT', '-z', previous.commit, head] : ['ls-tree', '-r', '--name-only', '-z', head])).split('\0');
    for (const file of paths) {
      if (!(source === 'cvelist' ? /^cves\/\d{4}\/[^/]+\/CVE-\d{4}-\d{4,}\.json$/ : /^advisories\/.*\/GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}\.json$/).test(file)) continue;
      // Read the pinned commit, never uncommitted worktree files. No fetch/pull/mutation of the upstream clone.
      let raw;
      try { raw = JSON.parse(await git(repo, ['show', `${head}:${file}`])); } catch { throw new Error('INVALID_SOURCE_FILE'); }
      addCounts(counts, await importDocument(pool, source, raw, {sourceURL: `https://github.com/${expected}/blob/${head}/${file}`}));
      counts.files = (counts.files || 0) + 1;
    }
    await transaction(pool, client => checkpoint(client, `git:${source}`, {commit: head}));
  });
}
async function importPath(pool, source, input) {
  return withSyncLock(pool, source, async counts => {
    async function visit(file) {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) throw new Error('SOURCE_SYMLINK_REFUSED');
      if (stat.isDirectory()) {
        for (const name of (await fs.readdir(file)).sort()) if (!name.startsWith('.')) await visit(path.join(file, name));
      } else if (stat.isFile() && file.endsWith('.json')) {
        if (source === 'cvelist' && !/^CVE-\d{4}-\d{4,}\.json$/.test(path.basename(file))) { counts.ignored = (counts.ignored || 0) + 1; return; }
        if (stat.size > 64 * 1024 * 1024) throw new Error('SOURCE_TOO_LARGE');
        let raw; try { raw = JSON.parse(await fs.readFile(file, 'utf8')); } catch { throw new Error('INVALID_SOURCE_FILE'); }
        addCounts(counts, await importDocument(pool, source, raw)); counts.files = (counts.files || 0) + 1;
      }
    }
    await visit(path.resolve(input));
    if (!counts.files) throw new Error('NO_SOURCE_FILES');
  });
}
async function syncKev(pool, {download = createDownloader()} = {}) {
  return withSyncLock(pool, 'kev', async counts => {
    const raw = await download('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json');
    if (!Array.isArray(raw.vulnerabilities) || raw.count !== raw.vulnerabilities.length || !date(raw.dateReleased)) throw new Error('INVALID_KEV_CATALOG');
    const previous = await getCheckpoint(pool, 'kev');
    const released = date(raw.dateReleased);
    if (previous && released < previous.released) throw new Error('STALE_KEV_CATALOG');
    await transaction(pool, async client => {
      const total = {};
      for (const item of unpack('kev', raw)) addCounts(total, await ingest(client, 'kev', item.raw, {catalogDate: item.catalogDate}));
      // KEV is a complete snapshot; removals change only membership, preserving observations.
      const deleted = await client.query("DELETE FROM cve.records WHERE source='kev' AND NOT(cve_id=ANY($1::text[]))", [raw.vulnerabilities.map(v => v.cveID)]);
      total.unlinked = deleted.rowCount;
      await checkpoint(client, 'kev', {released, catalog_version: raw.catalogVersion});
      return total;
    }).then(value => addCounts(counts, value));
  });
}
module.exports = {createDownloader, nvdWindow, syncNvd, syncGit, importPath, syncKev, withSyncLock};
