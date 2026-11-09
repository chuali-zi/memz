# Memz · 面向 AI 智能体的漏洞知识库

**产品方向（2026-11-09）：Memz 的核心且唯一的知识领域是漏洞知识与 CVE 详情。** Memz 是智能体的外部数据库：帮助智能体从已识别的技术栈或服务出发，找到相关漏洞、理解适用条件、获取可回查的依据，并形成下一步验证思路。成功标准是让智能体完成有效检索和判断；保存 CVE、接受正确参数并返回 JSON 只是基础能力。

后续开发先读 [产品需求与验收](docs/cve-product-direction.md)、[检索树设计](docs/cve-retrieval-tree.md) 和 [CVE 接入说明](cve/README.md)。[AGENTS.md](AGENTS.md) 固定本方向，防止后续 agent 把旧项目记忆、候选审批、聊天历史或比赛演示继续当作产品主线。

## 智能体如何使用 Memz

1. **发现能力**：服务说明告诉智能体什么时候用 Memz、有哪些检索入口、如何处理空结果与证据不足。
2. **浏览检索树**：技术栈/服务家族 → 具体服务或组件 → 漏洞类型（CWE）→ CVE 候选。例如 Web 服务 → Nginx → 已导入资料中的弱点类别；SQL 数据库 → MySQL → 弱点类别。只有真实导入的证据才能产生 CVE 叶子。
3. **读取可用知识**：返回命中依据、来源、受影响范围的完整证据入口、已知利用标记、仍待确认的条件，以及下一步检查建议。建议和来源事实分开标记；缺失信息明确呈现。
4. **按证据继续**：读取固定 observation 的完整版本区间和配置条件，再由调用方决定后续测试。检索命中本身不等于目标存在漏洞。

同一个 CVE 可以出现在多个服务或类型下，但身份和证据不复制。`SQL 数据库` 是技术类别，`SQL 注入` 是漏洞类别；二者不等同。自然语言模糊检索保留独立策略接口，目前不把英文词项检索称为语义理解。

## 当前工程入口

- 核心目录：`cve/`；独立数据库结构：`db/cve_schema.sql`。
- 安装：Node.js 22+、PostgreSQL 16，仓库根目录运行 `npm ci`。
- 迁移、导入、启动：`node scripts/cve_cli.js migrate / import / serve`，具体参数和角色权限见 [CVE README](cve/README.md)。必须显式配置 `CVE_DATABASE_URL`；读取服务默认监听 `127.0.0.1:3100`。
- 智能体入口：HTTP 与 `node scripts/cve_mcp.js`。能力发现、检索树、上下文与完整证据契约见 [检索树设计](docs/cve-retrieval-tree.md)。
- 验证：`node --test cve/test/*.test.js`；真实数据库检查需显式测试连接，结果与限制记录在 [CVE 状态](cve/STATUS.md)。

现有 `npm start`、根 `server.js`、`public/` 和下面的材料属于旧项目记忆原型；当前阶段保留代码与用户数据用于迁移参考，不作为新产品启动路径。旧的模型记忆评测不能证明漏洞检索质量。检索树的验收要区分合成回归、真实语料召回率、延迟及智能体任务效果。

<details>
<summary>历史项目记忆原型：运行、升级、比赛材料与证据（不再定义产品方向）</summary>

## 历史定位：可审计的项目上下文记忆

为项目智能体维护可审计的已批准上下文：提议关联来源，经负责人审批后形成不可变修订，可回查当前值、旧版本和原文。网页、HTTP与MCP客户端真实访问本机数据库；MCP默认只读，页面的模拟agent按钮明确标注为模拟，不调用模型。账号与初始数据均为公开合成样例，尚不具备公开生产部署所需的身份认证等能力。

## 与只保存聊天记录有什么不同？

聊天记录保存“谁说过什么”；Memz额外维护“哪一项变更已经批准、当前是哪个版本、依据来自哪里”。例如先批准20号，再批准更正为15号；之后收到基于旧版本的25号提议和被驳回的30号提议，当前事实仍是15号v2，20号v1及其来源仍可回查。它不会自动判断材料真假，也不替代聊天原文。

[可复现对照](docs/demo-script.md#同一输入的对照阅读)在同一合成流程中展示“最后收到的提议”与实际批准事实：前者最终为30号，后者仍为15号v2。对照是明确定义的简易读取规则，不是其他聊天系统或模型的效果评测。运行后的表格含本次真实候选、版本和来源ID。

工程化迭代与下一阶段验收见[产品化推进记录](docs/productization-progress.md)。启动前可先做[离线 Compose 配置检查](docs/compose-safety.md)，运行时可观察[本机存活与基本就绪探针](docs/health-probes.md)；会话容量与数据库故障边界见[运行可靠性](docs/runtime-reliability.md)。

## 启动

首次接入者可按[开发者完整上手指南](docs/developer-quickstart.md)从空库走到来源、审批和客户端上下文；包含第二终端配置、预算续读以及实际遇到的安装问题。以下命令使用POSIX shell语法。

需要 Docker Compose、Node.js 22+ 和 npm，端口 5432、3000 可用。默认仅绑定127.0.0.1；HTTP Host只接受localhost、127.0.0.1或[::1]及合法端口，不接受自定义域名。不需外部账号或 API key。主机名校验不是身份认证，公开账号仍仅供演示，详见[运行边界](docs/demo-boundary.md)。

```sh
npm ci
docker compose up -d --wait
node scripts/check-setup.js && npm start
```

`npm start` 用于交互开发，前台终端的 Ctrl+C 通常发送给整个前台进程组。需要 supervisor 或精确 PID 信号停止服务时，启动项应直接执行 `node server.js`（exec 形式），让信号送达应用进程；不要假设 npm PID 就是应用 PID。停止与排空边界见[运行可靠性](docs/runtime-reliability.md#命令行服务启动与退出)。

访问 http://127.0.0.1:3000 。首次启动时 `db/schema.sql` 由 PostgreSQL 的初始化入口以迁移 owner 执行，创建应用角色、表、RLS 和种子。可用账号：`owner` / `demo-owner`、`member` / `demo-member`、`viewer` / `demo-viewer`、`other` / `demo-other`。这些凭据是公开的，仅供演示。

重置会**删除本项目数据库卷里的所有数据**，并重新迁移和导入合成样例：

```sh
docker compose down -v
docker compose up -d --wait
```

启动前的 [只读诊断](docs/setup-check.md) 能提示误用管理员连接、基本表/迁移前提缺失和 RLS 配置问题；不自动修复，不代替完整演示或恢复验证。

已有卷不会自动重新执行 `schema.sql`，保留数据升级请使用下节的增量迁移，**不要重跑 schema 或删除卷**。环境变量 `PORT` 可修改应用监听端口（例如 `PORT=3001 npm start`）；使用启动日志显示的实际地址。环境变量 `DATABASE_URL` 可覆盖默认应用连接；数据库管理员凭据仅用于初始化与迁移，不传给应用服务。不要在公开网络暴露该服务。

本轮分别验证 Node 22.23.4（与 CI 匹配）和云环境 Node 24.22.1；Node 22/24 仍为官方 LTS，运行支持下限采用 22。[官方发布状态](https://nodejs.org/en/about/previous-releases)。这只调整运行前提，不修改数据库或服务接口；现有云环境仍使用默认 Node 24。

## 保留数据升级

`001-current-revision-integrity.sql` 加强当前修订约束，`002-create-idempotency.sql` 增加创建回执表，`003-membership-active.sql` 增加可停用的项目成员及对应权限过滤；三者支持原始schema与当前新安装版本，可重复执行，不修改已有事实、来源、候选、历史、审计或序列。每个脚本是独立事务，按编号顺序执行。先暂停应用写入，在仓库根目录、确认当前 Compose 项目就是待维护数据库后创建备份：

```sh
memz_backup=$(sh scripts/backup-before-migration.sh) &&
printf '备份保存于：%s\n' "$memz_backup"
```

脚本仅创建本次独有目录中的私有 `.dump`，不覆盖旧备份，不执行迁移；失败非零退出、stdout为空，仅清理本次文件。随后必须对**输出的本次备份**在独立空库实际恢复并验证，再决定继续；[随机库恢复测试](docs/backup-recovery.md)通过或仅能列出归档目录，都不能证明本次文件可恢复。

确认本次恢复验证通过后，回到同一终端的仓库根目录，以 schema owner 执行：

```sh
test -n "${memz_backup:-}" &&
test -s "$memz_backup" &&
docker compose exec -T db psql -U postgres -d memz -v ON_ERROR_STOP=1 < db/migrations/001-current-revision-integrity.sql &&
docker compose exec -T db psql -U postgres -d memz -v ON_ERROR_STOP=1 < db/migrations/002-create-idempotency.sql &&
docker compose exec -T db psql -U postgres -d memz -v ON_ERROR_STOP=1 < db/migrations/003-membership-active.sql
```

这两个 `test` 只防止备份步骤失败或文件丢失后误继续，不是恢复核验。备份失败会清空本次变量；任一前提或001/002失败都会短路后续迁移；003失败也以非零状态结束，不依赖 `set -e`。已有库和旧备份始终保留，不自动恢复或降级。

001在单事务内锁定 facts/revisions 并验证既有数据；003在独立事务中更新 memberships 结构与成员角色函数，保留原角色、成员行及历史引用。锁等待超过 5 秒或单条语句超过 60 秒即失败；安排维护窗口，确认没有活跃长事务后重试。若现有指针指向错误事实、版本不匹配或正版本缺少指针，迁移会报错并整体回滚，业务数据保留；不要用删除数据来绕过校验，应先核对来源与历史。迁移成功后再启动应用。这些脚本不提供自动降级，不是通用迁移框架。

停用由可信 schema owner 在维护窗口按确定项目和用户参数化更新，不增加应用权限或管理API；新请求生效，不取消已有事务快照。操作与边界见[项目成员停用](docs/demo-boundary.md#项目成员停用)。回退旧应用二进制时必须保留003的 `active` 与过滤后的 `member_role`，存在撤权时不得删除列或恢复未过滤函数。恢复旧备份可能重新授予备份后已撤销的访问，恢复流量前必须核对并补回撤权，详见[备份恢复](docs/backup-recovery.md)。

## 验证

按资源、权限和数据边界选择[分层测试入口](docs/testing.md)，区分无PG检查、隔离真实数据库、浏览器、故障恢复与材料包；CI矩阵及模型评测限制也在该索引说明。

推荐在已初始化的测试PostgreSQL上运行独立临时库系统测试，无需重置现有演示数据：

```sh
SYSTEM_TEST_DATABASE_URL=postgres://postgres:postgres_demo_only@127.0.0.1:5432/memz npm run test:system:evidence
```

它在随机临时库执行核心、真实备份恢复和迁移回归，保存原始TAP并清理自己创建的库。恢复测试需要PostgreSQL 16的pg_dump/pg_restore（优先使用/usr/lib/postgresql/16/bin，否则PATH）；本地只有数据库Docker工具时，可额外设置 `PG_TOOLS_CONTAINER=数据库容器名`，要求该容器可通过连接URL的主机和端口访问测试库。参见[备份恢复演练](docs/backup-recovery.md)。直接运行 `npm test` 还需显式 `MIGRATION_TEST_DATABASE_URL` 测试管理员连接供恢复测试创建随机库。原 `npm test` 会修改 `DATABASE_URL` 指向的数据库，且要求初始种子状态；不要对已有演示或业务库直接运行，也不需要为了推荐测试流程删除现有卷。

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

长期记忆公开基准的研究、固定数据清单、离线检索实验及后续公平比较方案见 [memory benchmarks](benchmarks/memory/README.md)。新增可选[批量溯源与来源去重](docs/context-optimization.md)，用 `npm run eval:context` 在独立临时库对比六种组合，记录请求数、输出字节、读取延迟和写入维护开销；需要显式 `CONTEXT_EVALUATION_DATABASE_URL`。仓库不包含第三方数据或源码；字节、检索证据命中与合成 HTTP 实验不代表真实模型的质量、加速或 token 节省结论。

## 真实模型效果实验

已完成使用 `DEEPSEEK_API_KEY` 的350次原创合成测试调用，另有1次连通性请求。留出集28题各重复两次：完整历史与新增历史读取均56/56正确，历史读取平均输入829 token（完整历史948）；原当前事实48/56，缺口为旧版本问题。显式reader投影保持当前事实成绩，平均输入由962降到646 token。这不代表公开基准、自动抽取或真实用户场景已验证。见[实验报告与逐题证据](benchmarks/memory/DEEPSEEK_RESULTS.md)、[工程入口与复现](docs/model-memory-evaluation.md)、[论文到工程](benchmarks/memory/RESEARCH_TO_ENGINEERING_2026-11-06.md)。

## 演示（约 7 分钟）

完整合成故事可运行 `MEMZ_DEMO_BASE_URL=http://127.0.0.1:3000 node scripts/demo-story.js --markdown`：在显式选定的本地演示库新增唯一主体记录，展示实际批准、冲突、历史依据和客户端上下文；不会删除已有数据。执行范围与失败处理见[演示脚本](docs/demo-script.md)。

1. 用负责人登录，查看截止日 20号、v1、会议纪要来源和历史；指出账号与数据是合成的。
2. 在候选表单选择「负责人更正」，填 15号、基于 v1 并提交；审批后当前事实为 15号、v2，历史保留 v1。
3. 点击模拟旧版本 agent，审批其 v1 候选，显示 409；当前值不变。重复审批已批准候选也会被拒绝。
4. 点击外部指令模拟，展示原文只作为不可信来源和待审批候选；它不会自动覆盖事实。可驳回。
5. 切换只读账号，提议会被拒绝；切换另一项目用户，界面仅显示独立项目。演示中文关键词检索、来源与审计。

## 比赛材料准备

已按本机核实的原通知整理[交付对照与后续优先级](docs/competition-deliverables.md)，列明六项文档要求、现有证据和缺口。当前仍是演示原型，不表示已经报名或提交。

材料编写还可参考[需求—验收—证据表](docs/requirements-acceptance.md)和[关键实现说明](docs/key-implementation.md)，两者区分已验证行为与实际限制。

## 设计与限制

详见 [数据模型与取舍](docs/design.md)、[数据字典](docs/data-dictionary.md)与[接口及时序](docs/api-sequences.md)。数据库用事务局部身份设置和 RLS 限制项目范围；应用连接为非 owner、非超级用户、无 BYPASSRLS。会话是服务端随机不透明 cookie，浏览器身份不来自请求中的 user_id 或角色；状态更改要求 CSRF token。来源内容以文本呈现，默认搜索是参数化的字面子串匹配；可显式启用[多关键词全部匹配](docs/lexical-retrieval.md)，让空白分隔的词片段跨主体、属性、当前值组合检索，仍按事实 ID 分页，**不是语义搜索**。

这是单机演示：固定公开账号、内存 session（重启失效，未做集群/速率限制）、HTTP 本机运行、尚无真实用户智能体流程、文档自动导入、真实语料或语义检索评测；独立DeepSeek实验只验证合成数据上的读取阶段。该 RLS 设计信任应用服务设置事务身份；已获得应用数据库凭据的人可以自己设置身份，不能抵御此类攻击。生产部署还需真实身份认证、密钥管理、会话存储、TLS、权限复核与安全审计。数据库账号密码只供本地演示。

仅取当前事实可使用兼容新增的[游标分页接口](docs/bounded-retrieval.md)，默认 50、最多 100 条；页面已接入50条分页；原聚合接口默认完整响应仍兼容。历史也采用[独立分页](docs/history-pagination.md)，每页25条；[候选分页与状态筛选](docs/candidate-pagination.md)每页25条，[来源也按标题检索与分页](docs/source-pagination.md)，已选依据跨页保留。[审计分页](docs/audit-pagination.md)每页25条，可查看100条之后的早期操作。五类列表可独立读取，整页刷新用于重新核对。

## 比赛材料与证据包

[六项初赛材料草稿](docs/submission-report.md)和[可重复演示步骤](docs/demo-script.md)按已知要求整理。先在同一干净提交生成数据库系统、检索与UI报告，再运行 `npm run evidence:package`，离线校验并输出源码、文档、31图、原始报告及SHA-256清单。解包后可运行 `node scripts/package-evidence.js verify .`。CI另归档competition-evidence；包的存在不等于整次CI已成功。操作条件与真实性限制见[材料包说明](docs/evidence-package.md)。

数据库约束与迁移的原始TAP取证、清理记录及材料包对应关系见[数据库测试证据](docs/database-evidence.md)。

首次启动、端口核对与有限彩排范围见[首次运行检查](docs/first-run.md)。

来源分页的PostgreSQL执行计划、固定规模及正确性实验见[查询计划证据](docs/query-plans.md)，使用 `npm run eval:plans` 和显式PLAN_DATABASE_URL；CI单独归档query-plan-evidence。

当前事实和历史列表均可按版本展开确切原文、修订与候选ID，接口与合成接入步骤见[上下文接入及溯源](docs/context-client.md)。

可执行只读客户端：服务启动后运行 `MEMZ_QUERY=项目 npm run --silent demo:context`，输出固定版本与精确依据的JSON；无模型或SDK依赖，配置、截断及失败处理见上述接入说明。其他本地进程可运行 `node scripts/context-client.js --stdin`，发送单个JSON请求并关闭输入；凭据由父进程环境配置，输入及响应均有大小和时间限制。可选 `maxOutputBytes`（或 `MEMZ_MAX_OUTPUT_BYTES`）限制整份UTF-8 JSON输出，按完整事实及依据取前缀并标明省略，不截断来源正文。可将返回的 `nextAfter` 作为 `after`（或 `MEMZ_AFTER`）继续读取；跨页不是共同快照，详见接入说明。

外部本地进程可用[候选提交客户端](docs/proposal-client.md)通过标准输入提交绑定来源、带预期版本和稳定幂等键的候选。客户端管理会话与CSRF，只创建待审候选；批准仍由负责人通过原界面完成。

需要同时接入来源写入时，按[来源到候选的两步流程](docs/source-client.md)先调用source-client，再将实际返回的sourceId绑定到proposal-client。两个步骤独立保留幂等键，部分失败不会自动删除来源或批准候选。

本机智能体可使用 [MCP stdio 兼容适配](docs/mcp-local.md)：固定项目、默认只读，显式开启后可提交待审；支持 2025-11-25 握手，不提供审批工具。

| 使用目的 | MCP工具 | 开启方式 |
| --- | --- | --- |
| 读取当前批准事实与依据 | `memz_read_context` | 默认提供，字面关键词匹配 |
| 按明确字段问句读取当前值 | `memz_read_label_context` | 配置生成时加 `--label-context`；固定模板，不是语义搜索 |
| 回查批准历史、旧值与完整原文 | `memz_read_history_context` | 配置生成时加 `--history-context`；每次一页，显式续读 |
| 提出变更供负责人审批 | `memz_submit_proposal` | 按MCP说明单独开启；只创建pending候选 |

两个只读选项可以一起使用，例如 `node scripts/mcp-config.js --host vscode --label-context --history-context`。配置生成器始终关闭提议工具。历史读取的分页、整份输出预算和取消边界见[历史MCP接入](docs/mcp-history-context.md)；它不提供任意日期的生效时间查询，也不会自动遍历全部历史。

宿主配置可用 `node scripts/mcp-config.js --host claude-desktop` 或 `--host vscode` 生成，只输出待审阅 JSON，不修改用户设置。可用[显式字段问句配置](docs/mcp-config-label-context.md)加入 `--label-context`，提议工具仍关闭。

只读上下文客户端可用 `MEMZ_SEARCH_MODE=all_terms MEMZ_QUERY="截止日 项目" npm run --silent demo:context` 启用无序多关键词查询；查询至少含一个、至多八个不同字面片段。默认仍为整段 `substring`，页面和 MCP 继续使用默认模式。规则、回执验证和并发分页边界见[多关键词检索说明](docs/lexical-retrieval.md)。

显式设置 `MEMZ_PROVENANCE_MODE=snapshot MEMZ_SOURCE_MODE=deduplicated MEMZ_QUERY=项目 npm run --silent demo:context`，可在一次上下文请求中读取同一只读事务视图下的当前事实、完整依据与来源字典。此模式每页最多25条，来源全文按 ID 在 HTTP 响应中只传一次；原 individual/batch 模式及页面、MCP 默认行为保留。候选比较、协议、权限与跨页边界见[单页快照上下文](docs/snapshot-context.md)。这仍是人工批准事实的读取，不是自动长期记忆，也没有真实模型质量或端到端加速结论。

无需真实智能体账号即可演示只读 MCP：启动本机服务后运行 `node scripts/mcp-read-example.js "项目"`，通过官方 SDK 返回已批准版本及来源原文，详见 [MCP 说明](docs/mcp-local.md)。

来源与记忆文字始终是不可信数据，批准不使其中的指令可信。接口标记及宿主责任见 [记忆信任边界](docs/untrusted-memory.md)；未声称完整防提示注入或真实模型对抗验证。

显式的[字段模板上下文入口](docs/label-query-plan.md)可处理文档列明的当前字段问句，例如 `MEMZ_PROJECT_ID=1 MEMZ_QUESTION="项目的截止日是什么？" npm run --silent demo:label-context`。它只读取授权批准事实并返回依据，范围超过25条或模板不覆盖时明确拒绝，不调用模型、不自动审批。当前栈的[小规模并发与连接池恢复基线](docs/reader-capacity.md)可用 `CAPACITY_DATABASE_URL=测试管理员连接 npm run eval:capacity` 在独立随机测试库重现；不要指向生产。

</details>
