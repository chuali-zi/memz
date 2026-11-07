const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Readable, PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { checkComposeSafety, readConfig } = require('../scripts/check-compose-safety');
const root = path.resolve(__dirname, '..');
const fixture = () => ({
  services: { db: {
    image: 'postgres:16',
    environment: { POSTGRES_PASSWORD: 'synthetic-password-canary' },
    ports: [{ host_ip: '127.0.0.1', target: 5432, published: '5432', protocol: 'tcp' }],
    volumes: [
      { type: 'volume', source: 'memz_data', target: '/var/lib/postgresql/data' },
      { type: 'bind', source: path.join(root, 'db/schema.sql'), target: '/docker-entrypoint-initdb.d/01-schema.sql', read_only: true }
    ],
    healthcheck: { test: ['CMD-SHELL', 'pg_isready -U postgres -d memz'] }
  } },
  networks: { default: { name: 'synthetic_default' } },
  volumes: { memz_data: {} }
});
const has = (config, code) => assert.ok(checkComposeSafety(config).checks.some(check => check.code === code));

test('local Compose guard accepts canonical project topology without echoing values', () => {
  const config = fixture(), before = structuredClone(config);
  const result = checkComposeSafety(config);
  assert.equal(result.ok, true);
  assert.equal(result.code, 'LOCAL_COMPOSE_CHECKS_PASSED');
  assert.deepEqual(config, before);
  assert.ok(!JSON.stringify(result).includes('synthetic-password-canary'));
  config.services.db.ports[0].host_ip = '::1';
  config.services.db.image = 'postgres:16.9@sha256:' + 'a'.repeat(64);
  assert.equal(checkComposeSafety(config).ok, true);
});

test('network guard rejects implicit, public, malformed and shared network bindings', () => {
  for (const host of [undefined, '', '0.0.0.0', '::', 'localhost', '192.0.2.1']) {
    const config = fixture(); config.services.db.ports[0].host_ip = host;
    has(config, 'UNSAFE_NETWORK');
  }
  for (const published of ['0', '65536', '5432-5434', 'invalid']) {
    const config = fixture(); config.services.db.ports[0].published = published;
    has(config, 'UNSAFE_NETWORK');
  }
  for (const network of ['host', 'service:other', 'container:synthetic']) {
    const config = fixture(); config.services.db.network_mode = network;
    has(config, 'UNSAFE_NETWORK');
  }
  for (const network of [{ external: true }, { driver: 'host' }, { driver_opts: { parent: 'synthetic' } }]) {
    const config = fixture(); config.networks.default = network;
    has(config, 'UNSAFE_NETWORK');
  }
  const config = fixture(); config.services.db.ports.push({ host_ip: '0.0.0.0', target: 5432, published: '5433' });
  has(config, 'UNSAFE_NETWORK');
});

test('guard rejects extra permissions and unexpected image versions', () => {
  for (const extra of [{ privileged: true }, { cap_add: ['SYS_ADMIN'] }, { devices: ['/dev/synthetic'] },
    { pid: 'host' }, { ipc: 'host' }, { userns_mode: 'host' }, { uts: 'host' },
    { security_opt: ['seccomp:unconfined'] }, { sysctls: { synthetic: '1' } }, { volumes_from: ['other'] }]) {
    const config = fixture(); Object.assign(config.services.db, extra);
    has(config, 'UNSAFE_PRIVILEGES');
  }
  for (const image of ['postgres', 'postgres:latest', 'postgres:17', 'untrusted/postgres:16', '${IMAGE}']) {
    const config = fixture(); config.services.db.image = image;
    has(config, 'UNEXPECTED_IMAGE');
  }
});

test('mount guard rejects writable or replaced schema, host data and reused external storage', () => {
  for (const change of [
    c => { c.services.db.volumes[1].read_only = false; },
    c => { c.services.db.volumes[1].source = '/synthetic/schema.sql'; },
    c => { c.services.db.volumes[0].type = 'bind'; },
    c => { c.services.db.volumes[0].read_only = true; },
    c => { c.volumes.memz_data = { external: true }; },
    c => { c.volumes.memz_data = { driver_opts: { device: '/synthetic' } }; },
    c => { delete c.volumes.memz_data; },
    c => { c.services.db.volumes.push({ type: 'bind', source: '/synthetic/docker.sock', target: '/var/run/docker.sock' }); },
    c => { c.services.db.tmpfs = ['/var/lib/postgresql/data']; },
    c => { c.services.db.configs = [{ source: 'synthetic', target: '/etc/synthetic' }]; },
    c => { c.services.db.secrets = ['synthetic']; }
  ]) {
    const config = fixture(); change(config); has(config, 'UNSAFE_MOUNTS');
  }
});

test('uninspected runtime overrides cannot receive a passing report', () => {
  for (const extra of [{ command: ['synthetic'] }, { entrypoint: '/synthetic' }, { env_file: ['synthetic.env'] },
    { environment: { PGDATA: '/synthetic' } }]) {
    const config = fixture(); Object.assign(config.services.db, extra);
    has(config, 'UNSUPPORTED_RUNTIME_OVERRIDES');
  }
});

test('invalid or unsupported topology and disabled health checks fail closed', () => {
  for (const config of [null, [], {}, { services: [] }]) has(config, 'INVALID_INPUT');
  for (const config of [{ services: {} }, { services: { db: null } }, { services: { db: {}, extra: {} } }]) has(config, 'UNSUPPORTED_TOPOLOGY');
  for (const health of [undefined, {}, { disable: true, test: ['CMD', 'synthetic'] }, { test: ['NONE'] }, { test: ['CMD-SHELL', ''] }]) {
    const config = fixture(); config.services.db.healthcheck = health; has(config, 'HEALTHCHECK_REQUIRED');
  }
  const config = fixture(); config.services.db.ports = ['127.0.0.1:5432:5432'];
  has(config, 'UNSAFE_NETWORK');
});

test('stdin parser bounds bytes and time, and hides malformed data and stream errors', async () => {
  assert.equal((await readConfig(Readable.from([JSON.stringify(fixture())]))).ok, true);
  for (const text of ['', '{"synthetic-password-canary":', 'null']) {
    const result = await readConfig(Readable.from([text]));
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes('synthetic-password-canary'));
  }
  const tooBig = await readConfig(Readable.from(['密码密码']), { maxBytes: 4 });
  assert.equal(tooBig.checks[0].code, 'INPUT_LIMIT');
  const hanging = new PassThrough();
  const timeout = await readConfig(hanging, { timeoutMs: 20 });
  assert.equal(timeout.checks[0].code, 'INPUT_LIMIT'); hanging.destroy();
  const broken = new PassThrough(), pending = readConfig(broken);
  broken.destroy(new Error('synthetic-password-canary'));
  assert.equal((await pending).checks[0].code, 'INVALID_INPUT');
});

test('CLI returns machine-readable success/failure without raw input or stderr', () => {
  const run = input => spawnSync(process.execPath, ['scripts/check-compose-safety.js'], { cwd: root, input, encoding: 'utf8', timeout: 10000 });
  const success = run(JSON.stringify(fixture()));
  assert.equal(success.status, 0); assert.equal(success.stderr, ''); assert.equal(JSON.parse(success.stdout).ok, true);
  const config = fixture(); config.services.db.ports[0].host_ip = 'synthetic-password-canary';
  for (const input of [JSON.stringify(config), '{synthetic-password-canary']) {
    const failure = run(input);
    assert.equal(failure.status, 1); assert.equal(failure.stderr, ''); assert.equal(JSON.parse(failure.stdout).ok, false);
    assert.ok(!failure.stdout.includes('synthetic-password-canary'));
  }
});
