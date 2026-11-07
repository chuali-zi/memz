# 按层选择测试入口

以下命令在完整仓库根目录执行，先按[上手指南](developer-quickstart.md)安装锁定依赖。Node需22+；浏览器、PostgreSQL和Docker只在相应层需要。这里说明入口与权限，不是固定通过数或某次CI成功声明。

## 先选数据边界

- 不需要数据库时，选择下面的明确文件或合成浏览器测试；仓库没有独立的 `test:unit` npm别名。
- 真实数据库回归推荐 `test:system:evidence`。它创建随机测试库，不重置管理员URL指定的已有库，不要求删除现有卷或停止已有3000端口服务。
- **不要把直接 `npm test` 当纯单元测试。** 它执行所有 `test/*.test.js`，包含真实PG集成并会修改 `DATABASE_URL` 的种子数据；也需要 `MIGRATION_TEST_DATABASE_URL`。普通使用者应通过隔离runner运行，不要沿用业务库连接。
- 真实PG入口需已初始化的专用测试PostgreSQL16及现有公开演示应用角色 `memz_app`；初始化步骤只用于明确的新测试实例，不能对业务库重跑schema。应用仍以非owner角色连接。
- 系统/core内部分fixture还创建随机登录角色，并执行schema owner、SET ROLE或自有后端管理检查。测试管理员须能创建/清理自有数据库和角色，并具备这些fixture所需管理权限；仅CREATEDB不够。推荐专用测试实例的postgres管理员，**不使用生产管理员凭据，也不把它传给应用**。

下文真实PG命令共用这个变量。示例是公开本机测试配置，运行前换成明确选定的专用测试实例和端口；不要为了照抄命令改动现有数据：

```sh
MEMZ_TEST_ADMIN_URL='postgres://postgres:postgres_demo_only@127.0.0.1:5432/memz'
```

## 入口与所需资源

| 目的 | 可执行命令 | 资源与结果边界 |
| --- | --- | --- |
| 快速纯函数/内存检查 | `node --test test/session-store.test.js test/search-query.test.js test/label-query-plan.test.js` | 无PG/浏览器/模型；是明确子集，不是全部core |
| HTTP消费者合同漂移 | `node --test test/consumer-contract.test.js` | 真本机HTTP、合成pool/fake transport及CLI；无PG。核对[8入口OpenAPI子集](consumer-contract.md)，不等于通用OpenAPI验证器或真实RLS验收 |
| 完整核心＋迁移隔离取证 | `SYSTEM_TEST_DATABASE_URL="$MEMZ_TEST_ADMIN_URL" npm run test:system:evidence` | 随机库/部分随机角色；含真实SQL、HTTP/客户端/MCP、提交故障及custom备份恢复。需PG16 dump/restore工具；保存 `artifacts/system/run-*/` |
| 单独迁移回归 | `MIGRATION_TEST_DATABASE_URL="$MEMZ_TEST_ADMIN_URL" npm run test:migrations` | 原始旧schema及新schema的随机库；不是在用户库直接执行升级。详见[数据库证据](database-evidence.md) |
| API HTTP缓存边界 | `npm run test:http-cache` | 真Chromium原生HTTP缓存与Express路由、明确合成pool，无PG；退出/切账号/合成撤权后的显式缓存与默认fetch对照。见[缓存范围](http-cache.md)，不证明BFCache、旧缓存清除或生产身份 |
| 浏览器交互、响应式 | `npm run test:product:ui`；`npm run test:responsive:ui` | 真Chromium/静态页面、明确合成API回执，无PG。需可执行浏览器、系统库及中文字体；不证明数据库提交或重启 |
| 完整真实PG界面取证 | `UI_TEST_DATABASE_URL="$MEMZ_TEST_ADMIN_URL" npm run test:ui:evidence` | 随机 `memz_ui_*` 库与自建服务，真Chromium；保存 `artifacts/ui/run-*/`。不要用会修改现有3000端口服务的旧 `test:ui` 代替 |
| 新增同页面会话恢复集成 | `SESSION_RECOVERY_DATABASE_URL="$MEMZ_TEST_ADMIN_URL" npm run test:session-recovery` | 显式opt-in脚本；随机PG库、真实Node CLI重启与Chromium，复用现有app角色。独立报告在 `artifacts/session-recovery/run-*/`；不属于默认 `*.test.js` core；当前两个Node CI job分别运行并归档 |
| 停机与恢复 | `npm run test:outage` | Linux Docker、postgres:16镜像及Chromium；仅停启自建容器/服务，不使用业务DATABASE_URL。报告 `artifacts/outage-report.json` 和浏览器证据，见[故障边界](demo-boundary.md) |
| 单独备份恢复演练 | `MIGRATION_TEST_DATABASE_URL="$MEMZ_TEST_ADMIN_URL" node --test test/restore.test.js` | 真实PG16 custom dump/restore、两个随机库；已包含在system/core中，按需单测即可。工具选择与限制见[恢复说明](backup-recovery.md) |
| 备份命令/工具进程检查 | `node --test test/backup-before-migration.test.js test/pg-tool-lifecycle.test.js` | 合成Docker替身/真实受控子进程，无PG；不生成用户有效备份，不替代上行真实恢复 |
| 真实服务的合成memory adapter | `MEMORY_TEST_DATABASE_URL="$MEMZ_TEST_ADMIN_URL" npm run test:memory:integration` | 随机库、真实Express/HTTP/PG、显式合成批准；无外部模型。需完整仓库，材料包不含该集成脚本 |
| 离线Python准备与预算回归 | `python3 -m unittest discover -s benchmarks/memory/tests -p 'test_*.py' -v` | 离线/合成transport，不要求provider密钥，不代表真实模型质量或LoCoMo评测 |

浏览器可用系统安装并显式设置 `CHROMIUM_PATH`；没有时按[浏览器复现说明](demo-evidence.md)安装Playwright对应Chromium及系统依赖。基础API接入不需要预装全部取证资源。各层命令不要并行指向同一可写演示数据；随机库也有CPU/PG资源成本。

所有清理结论以实际TAP/报告为准：fixture负责清理已登记的自建库/临时角色，但强制终止、连接失败或finally失败可能残留。核对确切owned名称后处理，不按前缀批量删除不明资源。通过随机归档恢复**不能证明用户这一次实际备份可恢复**；手工备份仍须在独立空库真实恢复、核对权限/版本/依据及后续写入。

## 检索与计划不是模型成绩

以下也是显式管理员入口，创建各自随机合成库；首次排错不必全部运行：

```sh
EVALUATION_DATABASE_URL="$MEMZ_TEST_ADMIN_URL" npm run eval:retrieval
CONTEXT_EVALUATION_DATABASE_URL="$MEMZ_TEST_ADMIN_URL" npm run eval:context
PLAN_DATABASE_URL="$MEMZ_TEST_ADMIN_URL" npm run eval:plans
PLAN_DATABASE_URL="$MEMZ_TEST_ADMIN_URL" npm run eval:exact-plans
```

它们分别记录合成检索正确性/HTTP字节、传输组合和实际SQL计划，输出 `artifacts/retrieval-report.json`、`context-optimization.json`、`query-plans.json`、`exact-reader-plans.json`。范围、冷热/观察者开销和审批fixture见对应[检索](retrieval-evaluation.md)、[上下文](context-optimization.md)、[查询计划](query-plans.md)、[精确读取计划](exact-reader-plans.md)文档；不能换算为模型token节省、费用或换栈收益。

CI里的Python与合成adapter通过都不触发真实provider推理。仓库不附真实LoCoMo语料；离线/合成测试没有证明LoCoMo质量。已有独立真实模型实验及其历史范围见[模型实验说明](model-memory-evaluation.md)，不能冒充本次测试矩阵的成绩。真实执行须另行显式授权，并满足入口的计数器、价格/费用预约及凭据前提；没有默认“跑测试就调用模型”。

## CI矩阵与同提交证据

以[当前工作流](../.github/workflows/ci.yml)为准：一个Python3.12离线job；Node22、24两个同内容集成job，`fail-fast: false`，各自15分钟。Node参数是major版本，实际patch以该次日志/报告为准。每个Node job依次做依赖/浏览器准备、API缓存对照、合成UI、隔离system、同页面重启恢复、合成adapter、检索/上下文/两类计划、Docker停机、真实PG UI及材料包；配置存在不等于某次执行成功。

Node22保留原产物名，Node24追加 `-node24`，例如 `system-test-evidence` / `system-test-evidence-node24`、`ui-evidence` / `ui-evidence-node24`、`competition-evidence` / `competition-evidence-node24`。`if: always()` 上传只说明保存了现场；看同提交、同job的完整终态、TAP、报告passed与清理，不能混拼两个runtime或旧提交的文件。会话恢复另上传 `session-recovery` / `session-recovery-node24`；它由工作流显式调用，不是被npm test自动发现。其他opt-in入口不自动等于默认CI步骤。

本机普通排错可以保留dirty-run记录，但正式[材料包](evidence-package.md)需要同一干净提交的system、retrieval和UI报告。完成三层后才运行 `npm run evidence:package`；它不会修复失败报告或把旧报告视为新提交通过。

## 材料包与首次运行

不安装、不连接数据库即可核验已有包（在包目录中执行）：

```sh
node scripts/package-evidence.js verify .
```

先核包，再复制到Git检出目录之外的独立目录，按锁文件单独安装运行，保留原包；不要链接已有node_modules冒充独立安装。包不含node_modules、完整Python/模型runner或合成adapter集成脚本；运行对应功能须按[包边界](evidence-package.md)准备依赖。loose package没有Git来源上下文时，不能git init伪造clean来源或直接生成新的system/UI/evaluation Git证据。

[已归档包首次运行smoke](../evaluation/evidence/package-first-run-2026-11-07/README.md)是指定旧包在同一云、温npm缓存、已有PG/角色下的独立安装＋HTTP检查。其取证runner不是通用安装器，**不要在归档目录原地执行**；它没有覆盖MCP、桌面宿主、完整core重跑或新集群/角色初始化。普通应用启动仍按[上手指南](developer-quickstart.md)，不能用一份历史smoke替代当前包核验与实际备份恢复。
