# Memz · 可审计的项目上下文记忆

面向项目协作智能体的数据库演示：把来源、候选、负责人审批、不可变修订和审计连接起来。当前客户端为明确标注的模拟程序，不调用模型；数据与账号均为合成样例。项目是比赛初版，不是生产系统。

## 启动

需要 Docker Compose、Node.js 20+ 和 npm，端口 5432、3000 可用。仅本机监听；不需外部账号或 API key。

```sh
npm ci
docker compose up -d --wait
npm start
```

访问 http://127.0.0.1:3000 。首次启动时 `db/schema.sql` 由 PostgreSQL 的初始化入口以迁移 owner 执行，创建应用角色、表、RLS 和种子。可用账号：`owner` / `demo-owner`、`member` / `demo-member`、`viewer` / `demo-viewer`、`other` / `demo-other`。这些凭据是公开的，仅供演示。

重置会**删除本项目数据库卷里的所有数据**，并重新迁移和导入合成样例：

```sh
docker compose down -v
docker compose up -d --wait
```

已有卷不会自动重新执行 `schema.sql`，保留数据升级请使用下节的增量迁移，**不要重跑 schema 或删除卷**。环境变量 `DATABASE_URL` 可覆盖默认应用连接；数据库管理员凭据仅用于初始化与迁移，不传给应用服务。不要在公开网络暴露该服务。

## 保留数据升级

`001-current-revision-integrity.sql` 加强当前修订约束，`002-create-idempotency.sql` 增加创建回执表；二者支持原始schema与当前新安装版本，可重复执行，不修改已有事实、来源、候选、历史、审计或序列。每个脚本是独立事务，按编号顺序执行。先暂停应用写入，备份并确认备份可用，再以 schema owner 执行：

```sh
mkdir -p backups
docker compose exec -T db pg_dump -U postgres -d memz -Fc > backups/before-001.dump
docker compose exec -T db psql -U postgres -d memz -v ON_ERROR_STOP=1 < db/migrations/001-current-revision-integrity.sql
docker compose exec -T db psql -U postgres -d memz -v ON_ERROR_STOP=1 < db/migrations/002-create-idempotency.sql
```

迁移在单事务内锁定 facts/revisions 并验证既有数据。锁等待超过 5 秒或单条语句超过 60 秒即失败；安排维护窗口，确认没有活跃长事务后重试。若现有指针指向错误事实、版本不匹配或正版本缺少指针，迁移会报错并整体回滚，业务数据保留；不要用删除数据来绕过校验，应先核对来源与历史。迁移成功后再启动应用。此脚本不提供自动降级，不是通用迁移框架。

## 验证

集成测试会修改演示数据，先重置，再运行（使用真实 PostgreSQL）：

```sh
docker compose down -v && docker compose up -d --wait
npm test
```

迁移测试在已经初始化的测试 PostgreSQL 上执行，显式提供管理员连接；它只创建和删除随机命名的 `memz_migration_*` 测试库，不修改连接指定的数据库。不要使用生产管理员凭据运行测试。

```sh
MIGRATION_TEST_DATABASE_URL=postgres://postgres:postgres_demo_only@127.0.0.1:5432/memz npm run test:migrations
```

测试覆盖有历史数据升级、新安装、重复和并发执行、异常数据整体回滚、迁移权限与锁超时、升级后应用角色继续写入及完整 HTTP 集成流程。`test/fixtures/schema-5317607.sql` 为提交 `5317607` 的原始 schema 快照。

推荐使用独立临时库的 `npm run test:ui:evidence`，无需重置已有数据或先启动服务；显式设置 `UI_TEST_DATABASE_URL`，浏览器设置与截图说明见[演示证据复现](docs/demo-evidence.md)。原 `npm run test:ui` 会修改3000端口服务使用的演示库，需初始种子状态；默认系统Chromium `/usr/bin/chromium`，可用 `CHROMIUM_PATH` 指定。截图与报告输出到被Git忽略的 `artifacts/ui/`，CI归档为 `ui-evidence`。测试结果不代表生产安全认证。

## 创建重试

来源与候选创建支持可选 `Idempotency-Key`，页面在同内容请求结果不确定时复用键；旧客户端不传键保持原行为。部署新版页面前先执行迁移002。范围、409冲突、原响应重放及限制见[幂等创建说明](docs/idempotent-creation.md)。

## 合成检索评测

运行 `npm run eval:retrieval` 可生成 19 个正确性用例与逐例 HTTP 延迟报告；需显式设置测试管理员连接，详见[数据集、运行步骤与测量限制](docs/retrieval-evaluation.md)。CI 自动保存 `retrieval-evaluation` 报告，不使用虚构成绩或跨环境性能阈值。

## 演示（约 7 分钟）

1. 用负责人登录，查看截止日 20号、v1、会议纪要来源和历史；指出账号与数据是合成的。
2. 在候选表单选择「负责人更正」，填 15号、基于 v1 并提交；审批后当前事实为 15号、v2，历史保留 v1。
3. 点击模拟旧版本 agent，审批其 v1 候选，显示 409；当前值不变。重复审批已批准候选也会被拒绝。
4. 点击外部指令模拟，展示原文只作为不可信来源和待审批候选；它不会自动覆盖事实。可驳回。
5. 切换只读账号，提议会被拒绝；切换另一项目用户，界面仅显示独立项目。演示中文关键词检索、来源与审计。

## 比赛材料准备

已按本机核实的原通知整理[交付对照与后续优先级](docs/competition-deliverables.md)，列明六项文档要求、现有证据和缺口。当前仍是演示原型，不表示已经报名或提交。

材料编写还可参考[需求—验收—证据表](docs/requirements-acceptance.md)和[关键实现说明](docs/key-implementation.md)，两者区分已验证行为与实际限制。

## 设计与限制

详见 [数据模型与取舍](docs/design.md)、[数据字典](docs/data-dictionary.md)与[接口及时序](docs/api-sequences.md)。数据库用事务局部身份设置和 RLS 限制项目范围；应用连接为非 owner、非超级用户、无 BYPASSRLS。会话是服务端随机不透明 cookie，浏览器身份不来自请求中的 user_id 或角色；状态更改要求 CSRF token。来源内容以文本呈现，搜索是参数化的中文子串关键词匹配，**不是语义搜索**。

这是单机演示：固定公开账号、内存 session（重启失效，未做集群/速率限制）、HTTP 本机运行、没有真实智能体/文档导入/真实语料或语义检索评测。该 RLS 设计信任应用服务设置事务身份；已获得应用数据库凭据的人可以自己设置身份，不能抵御此类攻击。生产部署还需真实身份认证、密钥管理、会话存储、TLS、权限复核与安全审计。数据库账号密码只供本地演示。

仅取当前事实可使用兼容新增的[游标分页接口](docs/bounded-retrieval.md)，默认 50、最多 100 条；页面已接入50条分页；原聚合接口默认完整响应仍兼容。历史也采用[独立分页](docs/history-pagination.md)，每页25条；[候选分页与状态筛选](docs/candidate-pagination.md)每页25条，来源仍整组加载。事实、历史和候选可独立读取，整页刷新用于重新核对。
