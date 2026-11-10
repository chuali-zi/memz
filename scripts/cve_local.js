'use strict';
// Local, isolated CVE runtime. Never reads DATABASE_URL or prints connection URLs.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const runFile = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');
const WINDOWS_PRIVATE_CHECK = `$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[System.IO.Directory]::GetAccessControl($env:CVE_LOCAL_RUNTIME_DIR); if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'permissions' }; $acls=@($acl); foreach ($name in @('config.json','owner.password')) { $file=[System.IO.Path]::Combine($env:CVE_LOCAL_RUNTIME_DIR,$name); if ([System.IO.File]::Exists($file)) { $acls+=([System.IO.File]::GetAccessControl($file)) } }; foreach ($item in $acls) { foreach ($rule in $item.Access) { if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'permissions' } } }`;
const NAMES = Object.freeze({owner: 'memz_cve_owner', reader: 'memz_cve_reader', ingester: 'memz_cve_ingester'});
const CODES = new Set(['CVE_LOCAL_INVALID_ARGUMENTS', 'CVE_LOCAL_CONFIG_REQUIRED', 'CVE_LOCAL_CONFIG_INVALID', 'CVE_LOCAL_PATH_UNSAFE', 'CVE_LOCAL_PRIVATE_STORAGE_FAILED', 'CVE_LOCAL_CONFIG_BUSY', 'CVE_LOCAL_UNMANAGED_DATA', 'CVE_LOCAL_DOCKER_FAILED', 'CVE_LOCAL_DATABASE_FAILED', 'CVE_LOCAL_ROLE_MISMATCH', 'CVE_LOCAL_DATABASE_MISMATCH']);
function failure(code) { return new Error(code); }
function safeErrorCode(error) { return CODES.has(error?.message) ? error.message : 'CVE_LOCAL_COMMAND_FAILED'; }
function locations(root = ROOT) {
  root = path.resolve(root);
  return {root, dataDir: path.join(root, 'data', 'cve', 'postgres'), runtimeDir: path.join(root, 'data', 'cve', 'runtime'), configFile: path.join(root, 'data', 'cve', 'runtime', 'config.json'), passwordFile: path.join(root, 'data', 'cve', 'runtime', 'owner.password')};
}
async function statMaybe(file) { try { return await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function assertSafePath(root, target, {file = false, exists = false} = {}) {
  root = path.resolve(root); target = path.resolve(target);
  const relative = path.relative(root, target);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw failure('CVE_LOCAL_PATH_UNSAFE');
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw failure('CVE_LOCAL_PATH_UNSAFE');
  let current = root;
  const parts = relative ? relative.split(path.sep) : [];
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const st = await statMaybe(current);
    if (!st) { if (exists) throw failure('CVE_LOCAL_CONFIG_REQUIRED'); return; }
    if (st.isSymbolicLink() || (i === parts.length - 1 && file ? !st.isFile() || st.nlink !== 1 : !st.isDirectory())) throw failure('CVE_LOCAL_PATH_UNSAFE');
  }
}
async function secureDirectory(directory) {
  try {
    if (process.platform === 'win32') {
      // A fresh protected DACL removes both inherited and explicit broad grants.
      // The path is a process environment value, never interpolated into shell source.
      const script = `$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[System.Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true,$false); $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [System.IO.Directory]::SetAccessControl($env:CVE_LOCAL_RUNTIME_DIR,$acl); ${WINDOWS_PRIVATE_CHECK}`;
      await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {windowsHide: true, timeout: 10000, env: {...process.env, CVE_LOCAL_RUNTIME_DIR: directory}});
    } else {
      await fs.chmod(directory, 0o700);
      const st = await fs.stat(directory);
      if ((st.mode & 0o077) !== 0 || st.uid !== os.userInfo().uid) throw new Error('permissions');
    }
  } catch { throw failure('CVE_LOCAL_PRIVATE_STORAGE_FAILED'); }
}
function validConfig(config) {
  return config?.version === 1 && /^[0-9a-f-]{36}$/.test(config.id || '') && config.project === 'memz-cve' && config.database === 'memz_cve' && config.host === '127.0.0.1' && config.port === 5433 &&
    Object.keys(NAMES).every(role => config.credentials?.[role]?.username === NAMES[role] && /^[0-9a-f]{64}$/.test(config.credentials[role].password || ''));
}
async function readConfig(paths) {
  await assertSafePath(paths.root, paths.configFile, {file: true, exists: true});
  await assertSafePath(paths.root, paths.passwordFile, {file: true, exists: true});
  await assertSafePath(paths.root, paths.dataDir);
  const st = await fs.stat(paths.configFile);
  if (st.size > 4096) throw failure('CVE_LOCAL_CONFIG_INVALID');
  if (process.platform !== 'win32') {
    for (const file of [paths.runtimeDir, paths.configFile, paths.passwordFile]) {
      const privateStat = await fs.stat(file);
      if ((privateStat.mode & 0o077) !== 0 || privateStat.uid !== os.userInfo().uid) throw failure('CVE_LOCAL_PRIVATE_STORAGE_FAILED');
    }
  }
  if (process.platform === 'win32') {
    try { await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PRIVATE_CHECK], {windowsHide: true, timeout: 10000, env: {...process.env, CVE_LOCAL_RUNTIME_DIR: paths.runtimeDir}}); }
    catch { throw failure('CVE_LOCAL_PRIVATE_STORAGE_FAILED'); }
  }
  let config;
  try { config = JSON.parse(await fs.readFile(paths.configFile, 'utf8')); } catch { throw failure('CVE_LOCAL_CONFIG_INVALID'); }
  if (!validConfig(config) || await fs.readFile(paths.passwordFile, 'utf8') !== config.credentials.owner.password) throw failure('CVE_LOCAL_CONFIG_INVALID');
  return config;
}
async function ensureLocalConfig({root = ROOT} = {}) {
  const paths = locations(root);
  await assertSafePath(paths.root, paths.runtimeDir);
  await assertSafePath(paths.root, paths.dataDir);
  if (await statMaybe(paths.configFile)) { await readConfig(paths); return {created: false, runtimeDir: paths.runtimeDir, dataDir: paths.dataDir}; }
  const contents = await statMaybe(paths.dataDir) ? await fs.readdir(paths.dataDir) : [];
  if (contents.length || await statMaybe(paths.passwordFile)) throw failure('CVE_LOCAL_UNMANAGED_DATA');
  await fs.mkdir(paths.runtimeDir, {recursive: true, mode: 0o700});
  await assertSafePath(paths.root, paths.runtimeDir, {exists: true});
  await secureDirectory(paths.runtimeDir);
  const lockPath = path.join(paths.runtimeDir, 'initialize.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') throw failure('CVE_LOCAL_CONFIG_BUSY'); throw e; }
  try {
    if (await statMaybe(paths.configFile) || await statMaybe(paths.passwordFile)) throw failure('CVE_LOCAL_CONFIG_BUSY');
    const config = {version: 1, id: crypto.randomUUID(), project: 'memz-cve', database: 'memz_cve', host: '127.0.0.1', port: 5433, credentials: {}};
    for (const [role, username] of Object.entries(NAMES)) config.credentials[role] = {username, password: crypto.randomBytes(32).toString('hex')};
    await fs.writeFile(paths.passwordFile, config.credentials.owner.password, {flag: 'wx', mode: 0o600});
    await fs.writeFile(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, {flag: 'wx', mode: 0o600});
    await fs.mkdir(paths.dataDir, {recursive: true, mode: 0o700});
    return {created: true, runtimeDir: paths.runtimeDir, dataDir: paths.dataDir};
  } finally { await lock.close(); await fs.unlink(lockPath); }
}
async function loadLocalConfig({role, root = ROOT} = {}) {
  if (!Object.hasOwn(NAMES, role || '')) throw failure('CVE_LOCAL_INVALID_ARGUMENTS');
  const paths = locations(root), config = await readConfig(paths), credential = config.credentials[role];
  const url = new URL(`postgresql://${config.host}:${config.port}/${config.database}`);
  url.username = credential.username; url.password = credential.password;
  return {databaseUrl: url.href, database: config.database, host: config.host, port: config.port, role, runtimeDir: paths.runtimeDir, dataDir: paths.dataDir};
}
async function dockerCommand(args, {root = ROOT} = {}) {
  const paths = locations(root);
  await readConfig(paths);
  await assertSafePath(paths.root, paths.dataDir, {exists: true});
  try {
    const result = await runFile('docker', ['compose', '--project-directory', paths.root, '-f', path.join(paths.root, 'compose.cve.yml'), '-p', 'memz-cve', ...args], {cwd: paths.root, windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024, env: {...process.env, COMPOSE_ENV_FILES: '', COMPOSE_DISABLE_ENV_FILE: '1'}});
    return result.stdout;
  } catch { throw failure('CVE_LOCAL_DOCKER_FAILED'); }
}
async function initializeDatabase({root = ROOT} = {}) {
  const {Client} = require('pg');
  const paths = locations(root), config = await readConfig(paths);
  const {databaseUrl} = await loadLocalConfig({role: 'owner', root});
  const client = new Client({connectionString: databaseUrl, connectionTimeoutMillis: 10000});
  client.on('error', () => {});
  try {
    await client.connect();
    const marker = `memz-cve-local:${config.id}`;
    const database = (await client.query("SELECT d.datname, r.rolname owner, shobj_description(d.oid,'pg_database') marker FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=current_database()" )).rows[0];
    if (database.datname !== config.database || database.owner !== NAMES.owner || database.marker && database.marker !== marker) throw failure('CVE_LOCAL_DATABASE_MISMATCH');
    if (!database.marker) {
      const existing = await client.query("SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname NOT LIKE 'pg_%'");
      if (existing.rowCount) throw failure('CVE_LOCAL_DATABASE_MISMATCH');
    }
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(1734702693, 2)');
    for (const role of ['reader', 'ingester']) {
      const {username, password} = config.credentials[role];
      const existing = (await client.query("SELECT r.*, shobj_description(r.oid,'pg_authid') marker, EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) memberships FROM pg_roles r WHERE rolname=$1", [username])).rows[0];
      if (existing) {
        if (existing.marker !== marker || !existing.rolcanlogin || existing.rolsuper || existing.rolcreatedb || existing.rolcreaterole || existing.rolreplication || existing.rolbypassrls || existing.rolinherit || existing.memberships) throw failure('CVE_LOCAL_ROLE_MISMATCH');
      } else {
        // Names are constants; passwords and marker have strict locally generated alphabets.
        await client.query(`CREATE ROLE ${username} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
        await client.query(`COMMENT ON ROLE ${username} IS '${marker}'`);
      }
    }
    await client.query(`COMMENT ON DATABASE memz_cve IS '${marker}'`);
    await client.query('REVOKE ALL ON DATABASE memz_cve FROM PUBLIC');
    await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await client.query('GRANT CONNECT ON DATABASE memz_cve TO memz_cve_reader, memz_cve_ingester');
    await client.query('COMMIT');
    // Authenticate existing managed roles without ever rotating their passwords.
    for (const role of ['reader', 'ingester']) {
      const probe = new Client({connectionString: (await loadLocalConfig({role, root})).databaseUrl, connectionTimeoutMillis: 10000});
      probe.on('error', () => {});
      try { await probe.connect(); } catch { throw failure('CVE_LOCAL_ROLE_MISMATCH'); } finally { await probe.end(); }
    }
    await client.query(await fs.readFile(path.join(root, 'db', 'cve_schema.sql'), 'utf8'));
    await client.query(`BEGIN;
      GRANT USAGE ON SCHEMA cve TO memz_cve_reader, memz_cve_ingester;
      REVOKE ALL ON ALL TABLES IN SCHEMA cve FROM memz_cve_reader, memz_cve_ingester;
      GRANT SELECT ON cve.records, cve.observations, cve.facets, cve.checkpoints, cve.sync_runs TO memz_cve_reader;
      GRANT SELECT, INSERT ON cve.observations TO memz_cve_ingester;
      GRANT SELECT, INSERT, UPDATE, DELETE ON cve.records TO memz_cve_ingester;
      GRANT SELECT, INSERT, DELETE ON cve.facets TO memz_cve_ingester;
      GRANT SELECT, INSERT, UPDATE ON cve.source_state, cve.checkpoints, cve.sync_runs TO memz_cve_ingester;
      GRANT SELECT, INSERT, UPDATE, DELETE ON cve.source_files TO memz_cve_ingester;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA cve TO memz_cve_ingester;
      ALTER ROLE memz_cve_reader SET default_transaction_read_only = on;
      COMMIT;`);
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw CODES.has(error.message) ? error : failure('CVE_LOCAL_DATABASE_FAILED');
  } finally { await client.end(); }
}
async function main(args = process.argv.slice(2)) {
  if (args.length !== 1 || !['setup', 'start', 'stop', 'status'].includes(args[0])) throw failure('CVE_LOCAL_INVALID_ARGUMENTS');
  const command = args[0];
  if (command === 'setup') {
    const config = await ensureLocalConfig();
    await dockerCommand(['up', '-d', '--wait', '--wait-timeout', '150', 'db']);
    await initializeDatabase();
    process.stdout.write(`${JSON.stringify({command, status: 'ready', database: 'memz_cve', host: '127.0.0.1', port: 5433, roles: {serve: 'reader', sync: 'ingester', migrate: 'owner'}, ...config})}\n`);
  } else if (command === 'start') {
    await dockerCommand(['up', '-d', '--wait', '--wait-timeout', '150', 'db']);
    process.stdout.write('{"command":"start","status":"ready","database":"memz_cve"}\n');
  } else if (command === 'stop') {
    await dockerCommand(['stop', 'db']);
    process.stdout.write('{"command":"stop","status":"stopped","data_retained":true}\n');
  } else {
    const output = await dockerCommand(['ps', '--format', 'json', 'db']);
    // Do not forward arbitrary Docker output, which can include environment values.
    let rows;
    try { rows = output.trim() ? output.trim().split(/\r?\n/).flatMap(line => { const value = JSON.parse(line); return Array.isArray(value) ? value : [value]; }) : []; } catch { throw failure('CVE_LOCAL_DOCKER_FAILED'); }
    process.stdout.write(`${JSON.stringify({command, project: 'memz-cve', database: 'memz_cve', containers: rows.map(row => ({name: row.Name === 'memz-cve-db' ? row.Name : 'unexpected', state: /^[a-z]+$/.test(row.State) ? row.State : 'unknown', health: /^(healthy|unhealthy|starting|)$/.test(row.Health || '') ? row.Health || null : 'unknown'}))})}\n`);
  }
}
if (require.main === module) main().catch(error => { process.stderr.write(`${safeErrorCode(error)}\n`); process.exitCode = 1; });
module.exports = {ensureLocalConfig, loadLocalConfig, initializeDatabase, assertSafePath, safeErrorCode, locations, main};
