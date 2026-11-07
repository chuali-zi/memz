// Offline guard for this repository's local-demo Compose topology.
// Never print input, parser errors, service names, paths or environment values.
const path = require('node:path');

const MAX_INPUT_BYTES = 1024 * 1024;
const INPUT_TIMEOUT_MS = 5000;
const messages = {
  INVALID_INPUT: '需要通过标准输入提供完整、规范化的 Compose JSON。',
  INPUT_LIMIT: '配置输入超过大小或等待时间限制。',
  UNSUPPORTED_TOPOLOGY: '仅支持本项目的单 db 服务拓扑；其他拓扑需独立评审。',
  UNSAFE_NETWORK: '数据库端口必须明确绑定本机回环地址，且不能共享宿主或其他服务网络。',
  UNSAFE_PRIVILEGES: '数据库服务包含额外权限、设备或宿主命名空间配置。',
  UNEXPECTED_IMAGE: '数据库镜像必须明确使用 postgres:16 系列。',
  UNSAFE_MOUNTS: '需要项目内只读 schema 初始化挂载和独立命名数据卷，不允许其他挂载。',
  UNSUPPORTED_RUNTIME_OVERRIDES: '自定义启动命令、数据目录或环境文件不在默认演示配置检查范围。',
  HEALTHCHECK_REQUIRED: '数据库必须配置启用的健康检查。',
  LOCAL_COMPOSE_CHECKS_PASSED: '本机演示 Compose 配置检查通过；仍需运行数据库诊断与隔离系统测试。'
};
const report = codes => ({
  ok: codes.length === 0,
  code: codes.length ? 'LOCAL_COMPOSE_CHECKS_FAILED' : 'LOCAL_COMPOSE_CHECKS_PASSED',
  checks: (codes.length ? codes : ['LOCAL_COMPOSE_CHECKS_PASSED']).map(code => ({ code, message: messages[code] }))
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== false;

function checkComposeSafety(config, { root = path.resolve(__dirname, '..') } = {}) {
  if (!object(config) || !object(config.services)) return report(['INVALID_INPUT']);
  if (Object.keys(config.services).length !== 1 || !object(config.services.db)) return report(['UNSUPPORTED_TOPOLOGY']);
  const db = config.services.db, codes = [];
  const ports = db.ports;
  const networks = config.networks === undefined ? {} : config.networks;
  if (db.network_mode !== undefined || !object(networks) ||
      Object.values(networks).some(network => !object(network) || network.external === true ||
        (network.driver !== undefined && network.driver !== 'bridge') || nonempty(network.driver_opts)) ||
      !Array.isArray(ports) || ports.length !== 1 || !object(ports[0]) ||
      !['127.0.0.1', '::1'].includes(ports[0].host_ip) || Number(ports[0].target) !== 5432 ||
      !/^[0-9]{1,5}$/.test(String(ports[0].published)) || Number(ports[0].published) < 1 || Number(ports[0].published) > 65535 ||
      (ports[0].protocol !== undefined && ports[0].protocol !== 'tcp')) codes.push('UNSAFE_NETWORK');
  if (db.privileged === true || nonempty(db.cap_add) || nonempty(db.devices) || nonempty(db.device_cgroup_rules) ||
      ['pid', 'ipc', 'userns_mode', 'uts'].some(key => db[key] !== undefined) || nonempty(db.volumes_from) ||
      nonempty(db.security_opt) || nonempty(db.sysctls)) codes.push('UNSAFE_PRIVILEGES');
  if (typeof db.image !== 'string' || !/^postgres:16(?:\.\d+){0,2}(?:@sha256:[a-f0-9]{64})?$/.test(db.image)) codes.push('UNEXPECTED_IMAGE');
  if ((db.command !== undefined && db.command !== null) || (db.entrypoint !== undefined && db.entrypoint !== null) ||
      nonempty(db.env_file) || (object(db.environment) && db.environment.PGDATA !== undefined &&
        db.environment.PGDATA !== '/var/lib/postgresql/data')) codes.push('UNSUPPORTED_RUNTIME_OVERRIDES');

  const mounts = db.volumes;
  const init = Array.isArray(mounts) && mounts.find(mount => object(mount) && mount.target === '/docker-entrypoint-initdb.d/01-schema.sql');
  const data = Array.isArray(mounts) && mounts.find(mount => object(mount) && mount.target === '/var/lib/postgresql/data');
  const volume = data && object(config.volumes) && Object.hasOwn(config.volumes, data.source) && config.volumes[data.source];
  const cleanVolume = object(volume) && !volume.external && !nonempty(volume.driver_opts) &&
    (volume.driver === undefined || volume.driver === 'local');
  if (!Array.isArray(mounts) || mounts.length !== 2 || !init || init.type !== 'bind' || init.read_only !== true ||
      typeof init.source !== 'string' || path.resolve(root, init.source) !== path.join(root, 'db/schema.sql') ||
      !data || data.type !== 'volume' || typeof data.source !== 'string' || !data.source || data.read_only === true ||
      !cleanVolume || nonempty(db.tmpfs) || nonempty(db.configs) || nonempty(db.secrets)) codes.push('UNSAFE_MOUNTS');
  const health = db.healthcheck;
  if (!object(health) || health.disable === true || !Array.isArray(health.test) ||
      !['CMD', 'CMD-SHELL'].includes(health.test[0]) || health.test.length < 2 ||
      health.test.slice(1).some(part => typeof part !== 'string' || !part.trim())) codes.push('HEALTHCHECK_REQUIRED');
  return report(codes);
}

function readConfig(input, { maxBytes = MAX_INPUT_BYTES, timeoutMs = INPUT_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let bytes = 0, chunks = [], finished = false;
    const done = value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      input.pause();
      resolve(value);
    };
    const onData = chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) return done(report(['INPUT_LIMIT']));
      chunks.push(Buffer.from(chunk));
    };
    const onEnd = () => {
      try { done(checkComposeSafety(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
      catch { done(report(['INVALID_INPUT'])); }
    };
    const onError = () => done(report(['INVALID_INPUT']));
    const timer = setTimeout(() => done(report(['INPUT_LIMIT'])), timeoutMs);
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
  });
}

if (require.main === module) {
  readConfig(process.stdin).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.ok) process.exitCode = 1;
    // A producer that never closes its pipe must not keep the CLI alive.
    process.stdin.destroy();
  });
}
module.exports = { checkComposeSafety, readConfig, MAX_INPUT_BYTES };
