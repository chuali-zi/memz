# 本机演示 Compose 配置校验

`scripts/check-compose-safety.js` 在启动前检查本项目默认的单数据库 Compose 拓扑，补充 [运行中数据库只读诊断](setup-check.md)。它只从标准输入读取规范化 JSON，不连接 Docker、数据库或网络，不打开 `.env`、环境文件或凭据文件，不启动或清理服务。

## 在启动前执行

在仓库根目录使用 Bash：

```bash
set -o pipefail
COMPOSE_DISABLE_ENV_FILE=1 docker compose --env-file /dev/null -f compose.yml \
  config --no-interpolate --no-env-resolution --format json 2>/dev/null \
  | node scripts/check-compose-safety.js
```

此命令需要支持上述选项的 Docker Compose 插件、Node.js 22+，不需要运行中的 Docker daemon、PostgreSQL 或 npm 依赖。Compose 负责解析 YAML、展开短语法，校验器接收规范化 JSON；不自行实现 YAML 解析。[Docker 官方配置命令说明](https://docs.docker.com/reference/cli/docker/compose/config/)列明这些选项。

命令显式选择仓库文件、禁用默认 `.env` 及 service 环境文件解析，并保留变量占位符；不读取环境文件中的秘密。Compose 的错误输出被丢弃，避免原始配置或插值错误进入共享日志；解析失败或空输入会得到校验器的固定失败 JSON。`pipefail` 使上游 Compose 失败也导致整个管道失败。不要将 Compose JSON 用 `tee`、shell 调试模式或临时文件另行归档，其中可能包含环境值。

本仓库当前配置没有变量插值。若自行添加 `${...}`、环境文件或启动覆盖，此静态检查不能用来批准运行；不要删除保护选项来消除错误。需要先独立评审覆盖配置。若确实使用多个 Compose 文件，须在上述命令中显式按实际启动顺序列出每个 `-f`；只检查基础文件不能证明其他 override 安全。

成功退出码为 0、`ok: true`、`code: LOCAL_COMPOSE_CHECKS_PASSED`；失败退出码为 1、`ok: false`，`checks` 含固定诊断代码。输出不包含输入配置、服务名、路径、环境值或底层解析错误。输入最多 1 MiB，等待标准输入关闭最多 5 秒；超限也退出失败。

## 检查与处理

| 诊断代码 | 检查内容及处理 |
| --- | --- |
| INVALID_INPUT / INPUT_LIMIT | 输入缺失、JSON 非法或输入超限；确认 Compose 版本与命令，勿公开原始配置 |
| UNSUPPORTED_TOPOLOGY | 仅允许一个名为 db 的服务；附加应用、代理或其他服务需独立评审 |
| UNSAFE_NETWORK | 仅允许一个 TCP 5432 映射，明确绑定 127.0.0.1 或 ::1，宿主端口 1–65535；拒绝共享网络、外部网络、非 bridge 驱动及网络驱动选项 |
| UNSAFE_PRIVILEGES | 拒绝特权模式、额外 capabilities、设备、宿主命名空间及额外安全或 sysctl 配置 |
| UNEXPECTED_IMAGE | 仅接受明确的 postgres:16 或 16.x 系列标签，可附 SHA-256 镜像 digest |
| UNSAFE_MOUNTS | 仅允许项目 db/schema.sql 的只读初始化 bind 和可写命名数据卷；数据卷不可 external 或带驱动选项，拒绝额外挂载、tmpfs、configs 与 secrets |
| UNSUPPORTED_RUNTIME_OVERRIDES | 拒绝自定义 command、entrypoint、环境文件及改变 PGDATA 的覆盖 |
| HEALTHCHECK_REQUIRED | 需要启用的 CMD 或 CMD-SHELL 健康检查；静态检查不执行命令 |

失败后先核对配置差异，保留已有数据库卷；这项检查不会自动修复。不要运行 `docker compose down -v` 来消除配置错误。

## 后续运行与范围

通过静态检查后按 README 启动数据库，再执行 `node scripts/check-setup.js`，并运行推荐的独立临时库系统测试；三者分别覆盖配置声明、运行中数据库前提和实际业务行为。校验器不会初始化数据库、运行迁移、验证备份恢复或改写权限。

本检查只对已列出的默认演示拓扑约定给出结论，不是完整 Compose 安全审计。它不验证镜像内容、镜像来源真实性、schema 文件内容或符号链接、健康检查的业务语义、Docker daemon 实际监听地址、防火墙、运行时容器状态、认证方式、密码强度、TLS 或所有 Compose 字段。命名数据卷也可能已包含历史数据，检查通过不表示空卷或可安全重置。公开演示账号和单机运行边界仍见 [默认运行与权限边界](demo-boundary.md)。

## 离线回归

```sh
node --test test/compose-safety.test.js test/compose-readiness.test.js
```

测试只使用合成配置，覆盖规范化配置成功、公开端口/host 网络、权限和挂载漂移、运行覆盖、非法输入、UTF-8 字节限制、输入超时、流错误及 CLI 退出码。故障配置带合成口令哨兵，用以确认输出不回显输入。这些测试无需 Docker 或数据库；现有系统测试按 `.test.js` 自动发现此文件。

`compose-readiness.test.js` 另检查真实 `compose.yml` 中显式 argv 的 TCP 命令及原2s/3s/30参数，防止生产配置回退为默认 Unix socket。它针对仓库当前的 JSON 兼容 YAML flow sequence，不是通用 YAML 解析器；真实 Compose 规范化条件由下面的独立测试验证。通用配置校验器继续兼容启用的 CMD/CMD-SHELL，不改变其检查范围。

## 首次初始化的 TCP 就绪

默认配置现在使用 `CMD pg_isready -h 127.0.0.1 -U postgres -d memz`。
本机缓存的 `postgres:16` 在原创4秒初始化 gate 中曾出现：旧 Unix socket
检查让 `compose --wait` 返回 healthy，但同容器的 TCP 检查仍 exit 2，且
gate 表尚未创建。显式 TCP 检查避开这个临时 Unix-only 初始化窗口。
原检查间隔2秒、单次超时3秒、重试30次保持不变。

healthy 只确认容器内 TCP 接受连接，不证明应用账号、RLS、schema完整性或
宿主端口可达。启动后仍需执行 `check-setup.js` 与隔离系统测试；测试中的
gate 是合成标记表，也不代替真实 schema 验收。

有 Docker 且已缓存 `postgres:16` 时，可显式运行：

```sh
node test/compose-first-start.js --execute
```

该文件故意不以 `.test.js` 结尾，不进入默认核心或 CI 单元测试；原生
PostgreSQL 用户无需 Docker。没有 `--execute` 时固定拒绝，不创建资源。
脚本使用唯一随机 Compose 项目、两个全新数据卷、无发布端口且
`network_mode:none`，只挂载原创4秒 gate，不挂载默认数据库或已有卷。
镜像必须本机缓存，禁止 pull；只使用本机 Docker socket和临时空客户端配置，
不读取继承环境值、dotenv、服务环境文件或注册表凭据。

它先读取禁插值、禁环境文件解析的生产规范化 healthcheck，再对同一项目的
旧命令验证“提前healthy而TCP/gate未就绪”，对现行命令验证
“healthy时TCP/gate已就绪”。总期限39秒，预留清理时间；成功或失败都尝试
清理自身项目并检查容器、卷和网络标签全部消失，保留第一失败及每步固定状态。
超限不能被报告为清理成功；若报告保留 `fixtureDirectory`，它仅属于本轮
随机项目，须核对该项目处理，不能对默认项目执行删除数据卷操作。

报告保存在 `artifacts/compose-first-start/<随机项目>.json`，含runner与compose
源码SHA256、缓存镜像ID、工具版本、观察时间、固定阶段/退出码和清理计数，
不保存配置环境值、原始错误正文或认证信息。这是有界初始化竞态回归，
不代表生产启动耗时保证，也不会启动应用或调用模型。
