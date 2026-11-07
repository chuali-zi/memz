# 本机存活与基本就绪探针

HTTP开始监听只表示端口可用，不表示数据库、迁移和权限前提已经成立。Compose的 `pg_isready` 也只检查PostgreSQL是否接受连接。本机服务提供两个只读观察入口：

```sh
curl -i http://127.0.0.1:3000/health/live
curl -i http://127.0.0.1:3000/health/ready
```

| 路径 | 成功 | 未通过 |
| --- | --- | --- |
| `GET /health/live` | 200，`{"status":"alive"}` | 停机gate仍返回503；此接口不检查数据库 |
| `GET /health/ready` | 200，`{"status":"ready"}` | 503，`{"status":"not_ready"}` |

HEAD执行同样的实时检查并返回相同状态与头，不返回正文。正常探针响应带 `Cache-Control: no-store`，直接结束固定JSON，不生成ETag；`If-None-Match` / `If-Modified-Since` 不会使它们变成304或跳过当前检查。不修改整个应用的缓存设置。

入口在原Host校验和停机gate之后、JSON解析与会话认证之前，不需要登录，不创建会话或下发cookie。停机时保留原有503和 `Connection: close` 行为，不继续查询数据库。它不是对外部署、外部监控服务或新的认证入口；仍受现有本机演示地址限制。query/body不控制项目、角色、schema、数据库地址或debug输出，也不会回显输入。两个入口都没有迁移、修复、业务写入或模型调用。

## readiness检查什么

readiness复用服务已有的应用连接池及事务helper，以空的事务局部身份执行只读REPEATABLE READ。它只运行一条固定catalog查询，与授权、业务读取使用同一个池和32个checkout交接槽位，不为每次探针创建Client或池，不从HTTP输入接受连接配置。检查结果只向应用返回一行固定布尔前提与最多八个固定表名的缺失列表；HTTP只输出上表状态。

检查包括：

- 应用数据库连接可用，实际会话身份和当前角色都不是超级用户、BYPASSRLS、CREATEROLE，也不能继承所需表的owner权限。启动时以管理员凭据连接再SET ROLE降权仍会失败，不把它称为安全应用凭据。
- public schema的八张基本表存在，并启用RLS；应用角色有SELECT权限。
- 两个已验证的facts当前修订约束名称存在，幂等回执表存在，用于检查迁移001/002的基本前提。
- `member_role(integer)` 存在且当前角色可执行。
- 所需列存在，基本类型为预期的int4/text/timestamptz/jsonb；每表存在适用于当前角色或PUBLIC的permissive SELECT或ALL策略。
- 当前角色有public schema的USAGE，会话row_security为on，应用未限定名称的表和 `member_role(integer)` 实际解析到本次检查的public对象。

同一目录检查也用于[离线诊断](setup-check.md)，后者保留详细的固定分类及原正常输出。新 `SCHEMA_PREREQUISITES` 表示列、类型、读取策略或运行时schema/RLS前提不符；HTTP不会公开这些分类、表名、用户名、数据库名、配置、SQL或原始异常。目录关系、内建函数、运算符和相关类型使用pg_catalog限定；解析检查只比较OID，不执行用户策略或业务函数。

事务身份初始化同样限定为 `pg_catalog.set_config`，仍在原顺序使用原值和事务局部scope。这样显式将pg_catalog放在search_path后面时，也不会先调用用户定义的同名函数。其他业务投影SQL没有为本探针重写；内部评测的全量baseline保留。

这些是基本前提，不是整个服务的完整验收：不读取事实、来源、候选或审计原文，不核对RLS表达式和身份函数实现是否正确，不证明所有写入授权、审批、当前依据、备份恢复或生产安全。每次检查使用新的目录快照，后续变更或故障仍可能使业务请求失败，不保证返回后持续就绪。通过后仍应运行来源—待审—审批—读取演示或隔离系统测试。readiness不阻止旧业务接口或CLI开始监听，也不自动修复失败条件。

## 失败、期限与复现

数据库认证失败、断开、目录检查不通过、checkout超时或admission繁忙，都只得到固定not_ready；liveness仍可独立返回alive。没有自动重试，也不以 `Promise.race` 让查询留在后台。沿用应用5秒checkout、10秒statement、15秒query读取等待；这些是分阶段/单语句期限，不是探针整体的请求时限或可用性SLO。BEGIN、局部身份设置、目录查询和COMMIT仍按原事务规则完成或回滚，坏连接丢弃；不改变原错误和清理规则。

```sh
node --test test/health-probes.test.js test/setup-check-deadlines.test.js
# 以下需要隔离测试管理员连接，测试自行创建和删除随机库：
MIGRATION_TEST_DATABASE_URL=... node --test test/health-probes-postgres.test.js test/setup-check.test.js
```

独立纯函数/真实loopback回归验证固定输出、实时HEAD/条件请求、无cookie、空身份、单catalog结果和drain门禁。真实PostgreSQL回归仅使用小型随机合成库，验证正常和旧schema、管理员/表owner、RLS/权限、列/类型/策略、缺迁移、认证失败、排队超时、admission和backend断连恢复，并记录实际目录行数/字节及零会话/零业务写。没有外部探针服务、部署或生产负载测试。
