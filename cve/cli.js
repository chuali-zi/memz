'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {Pool} = require('pg');
const {SOURCES, CVE_ID} = require('./normalize');
const {importDocument} = require('./store');
const {syncNvd, syncGit, syncKev, importPath, createDownloader, withSyncLock} = require('./sync');
const {search, evidenceContext} = require('./query');
const {serve} = require('./server');
function options(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!/^--[a-z_]+$/.test(args[i]) || args[i + 1] === undefined || args[i + 1].startsWith('--') || args[i].slice(2) in out) throw new Error('INVALID_ARGUMENTS');
    out[args[i].slice(2)] = args[i + 1];
  }
  return out;
}
async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args, opts = options(rest);
  const allowed = {migrate: [], import: ['source','path'], sync: ['source','repo','start','end','id'], serve: ['port'], query: ['id','q','vendor','product','version','cwe','cpe','kev','include_rejected','limit','after'], status: []};
  if (!allowed[command] || Object.keys(opts).some(k => !allowed[command].includes(k))) throw new Error('INVALID_ARGUMENTS');
  if (!process.env.CVE_DATABASE_URL) throw new Error('CVE_DATABASE_URL_REQUIRED');
  const pool = new Pool({connectionString: process.env.CVE_DATABASE_URL, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000});
  pool.on('error', () => process.stderr.write('CVE_DATABASE_CONNECTION_LOST\n'));
  let keep = false;
  try {
    let result;
    if (command === 'migrate') {
      await pool.query(await fs.readFile(path.join(__dirname, '..', 'db', 'cve_schema.sql'), 'utf8'));
      result = {migration: 'cve_schema', status: 'complete'};
    } else if (command === 'import') {
      if (!SOURCES.includes(opts.source) || !opts.path) throw new Error('INVALID_ARGUMENTS');
      result = await importPath(pool, opts.source, opts.path);
    } else if (command === 'sync') {
      if (opts.source === 'nvd' && !opts.repo && !opts.id) result = await syncNvd(pool, opts);
      else if (['cvelist','ghsa'].includes(opts.source) && opts.repo && !opts.start && !opts.end && !opts.id) result = await syncGit(pool, opts.source, opts.repo);
      else if (opts.source === 'kev' && Object.keys(opts).length === 1) result = await syncKev(pool);
      else if (opts.source === 'circl' && CVE_ID.test(opts.id || '') && Object.keys(opts).length === 2) {
        result = await withSyncLock(pool, 'circl', async counts => Object.assign(counts, await importDocument(pool, 'circl', await createDownloader()(`https://vulnerability.circl.lu/api/vulnerability/${opts.id}`))));
      } else throw new Error('INVALID_ARGUMENTS');
    } else if (command === 'query') result = evidenceContext(await search(pool, opts));
    else if (command === 'status') result = {
      records: (await pool.query('SELECT source,count(*)::int count FROM cve.records GROUP BY source ORDER BY source')).rows,
      checkpoints: (await pool.query('SELECT * FROM cve.checkpoints ORDER BY name')).rows,
      runs: (await pool.query('SELECT * FROM cve.sync_runs ORDER BY id DESC LIMIT 20')).rows
    };
    else if (command === 'serve') { serve(pool, Number(opts.port || 3100)); keep = true; return; }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally { if (!keep) await pool.end(); }
}
if (require.main === module) main().catch(error => {
  // Never print pg/fetch/git exceptions: they can contain credentials or upstream payloads.
  const code = /^[A-Z][A-Z_0-9]{0,63}$/.test(error.message) ? error.message : 'CVE_COMMAND_FAILED';
  process.stderr.write(`${code}\n`); process.exitCode = 1;
});
module.exports = {main, options};
