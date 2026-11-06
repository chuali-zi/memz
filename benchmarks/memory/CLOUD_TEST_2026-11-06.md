# memz 新云环境开发与验证报告（2026-11-06）

## 主要结果

真实模型调用 **0 次**，LoCoMo 实验 **0 题**。本次完成真实 memz adapter、独立检索评分器及强制预算入口；实际跑过真实 Express/HTTP/PostgreSQL 的**合成集成验证**。不能据此给出 memz 的回答正确率、token 节省、速度或费用优势。

最终代码通过：Python **68/68**，核心系统 **103/103**（其中新增 adapter 单测 8 项），数据库迁移 **9/9**，新增真实服务集成 **12/12**（1 个父测试、11 个子测试），无失败／跳过。JS 语法检查、Python compile、git diff 检查通过。

仅在本次选定的新云环境 `/workspace/memz` 的 `work` 分支工作。远端 `github.com/chuali-zi/memz.git` 的 main 最后只读核实仍为 `dd31a8733cf4f445c57d80896b3d855ca14bfa5f`。保留前序本地提交 `745490a`、`ceccd93e365a5a8defb7ff8715aa335d4c5ea0e7`；本轮实现提交 **`99dd46bc5561fd5cc33e9f0f69ff522b3452d909`**。未 push、开 PR、合并或部署。

## 凭据、网络与数据阻碍

| 操作／目标 | 确切证据与已完成部分 | 状态 |
| --- | --- | --- |
| 保险库配置 | 用户截图已确认 `GLM_API_KEY` 存在、类型为网络秘密、覆盖所有环境配置；无需重复保存或检查保险库范围 | confirmed |
| 当前实例注入 | 最后一次仅名称存在性检查为 absent。受支持的 environment_status 返回 observations_current=true、running，secret 绑定和 runtime_variables 列表均为空；当前配置版本与前序确认版本相同 | pending：当前运行实例无该绑定，不是保险库未保存 |
| 智谱官方 API 网络 | 当前 restricted 网络策略 enforced，有效许可域名中没有 `open.bigmodel.cn`；没有发认证或推理探测 | pending：环境侧目的地许可缺失；未尝试绕过 |
| 最新草稿／发布／secret 目的域名 | 状态工具只描述本任务绑定实例；最新可编辑配置和发布状态不可见。当前无 network-secret 绑定，不能从运行实例判断保险库内该 secret 的允许目的域名 | unknown；主会话继续环境配置检查 |
| Library 数据包落盘 | 官方 bundled download helper 初次和一次明确指向消费端目录的有界重试都报 `library download request failed: hosted apps tools/list request failed: network`；目标文件不存在 | pending：技术网络失败，非审批 denied，无不确定后台下载 |
| 数据哈希与安全解压 | 尚无可读数据字节；未计算本次哈希、列包或解压，没有把旧代码覆盖 checkout | pending |
| 真实模型实验 | 当前阶段明确不发外部模型请求；具体模型、已验证完整 chat tokenizer、价格／积分口径、请求及费用上限尚未配置为一次具体实验 | pending；认证未测、模型名未选、实际调用 0 |

数据包：`memz-benchmark-prep-2026-11-05.tar.gz`，Library ID `libfile_415877126b3c8191b27748345dcdd65f`，file ID `file_00000000ee1c81f5bdf46ffd1a57c4ca`，9,432,465 bytes。历史预期 SHA256：`8b3d80c158e1f52f91bef0ac40a88f701963ca050cb2ea3f44debfc779e772d5`，**本次未验证**。失败目标 `/workspace/memz-library-input/` 和 `/workspace/memz-library-input-retry/`。Library 报告读写正常不证明容器下载连接恢复；官方传递组件与上次相同，没有恢复证据，故未做第三次盲试。没有绕过此前 Hugging Face 限制、猜 URL 或换环境下载。

本次未读取、输出或存储任何模型 secret 值／占位符内容；没有修改 secret 类型、网络规则、凭据权限或环境。平台支持的 network-secret 占位符可正常使用，不要求明文变量。用户已授权智谱官方 API；不再用未经证实的账户／套餐推断阻塞任务。当前问题有环境绑定与网络元数据支持，不是账户用途争论。

最小后续动作：在同一个新 memz 环境配置中核实并完成 `GLM_API_KEY` 同名请求、官方目的域名及发布；不重配全部环境、不重新输入密钥到对话。最新草稿是否已改动仍 unknown。平台文档说明变更需 Republish，既有任务保留状态；后续任务需使用该新配置的更新版本。下载还需要受支持的服务／连接恢复，暂无证据要求重新上传数据。[云环境文档](https://learn.chatgpt.com/docs/environments/cloud-environments)

## 实现与安全边界

- `scripts/memz_adapter.js` 的 prepare 只接收 scope 和严格白名单历史字段，拒绝 question/gold/answer/evidence 等额外字段，复制后封存哈希。ingest 通过真实来源 API，使用确定性幂等键；不创建候选、不自动批准。审批仍走产品明确的负责人流程。
- freeze 绑定项目、reader、scope、来源、当前获批事实和不可变 revision/provenance。只读整个 25-fact snapshot 页与最多 100 来源，连续两次扫描一致才冻结；分页、重复／遗漏来源或非法回执失败。query 前后重新检查完整状态，冻结后新增来源、事实、版本或溯源变化使整行失败，不留下部分上下文。
- `memz_current` 将完整问题交给真实 `/context`；超长问题保留失败行。`flat_same_facts` 在同一已审事实集上做本地字面子串筛选，渲染／上下文字节上限相同。它是同事实集的结构基线，不是完整原始历史或无记忆基线；ASCII fixture 两者匹配并不提供算法质量优势证据。JS/SQL 的 Unicode 与 locale 语义可能不同。
- 每题保留来源文档 ID、版本／修订／候选／批准者、context/hash 和包含认证、读取、验证、注销、组装的 spans。无命中保留空上下文；scope／用户绑定错误、权限拒绝、分页和其他错误保留失败行。生成延迟、回答质量和 usage 未发生时保持 null。
- `scripts/memz_score.py` 是独立 evaluator；只有它接收 gold，校验历史、冻结、query、context、事实与 provenance，再计算 evidence 指标。错误／缺失行进入分母，空 evidence 为 N/A；检索覆盖不能当答案正确率。集成里的 gold sentinel 在 reader 完成后才创建。
- `glm_adapter.py` 的生产 Python 构造入口与 CLI 都强制 spend_guard，传入 custom transport 也不能默认跳过。无 guard 的模拟必须显式 simulation=True 并提供测试 transport；只用固定合成凭据、不读真实环境 key，结果标记 simulation。保留完整 request/input/output 限额、Decimal 费用预约、失败／超时不退款、无自动重试、缺 usage 或 provider 超额立即停止、cache/reasoning token 分栏。
- 前序响应凭据回显检查、固定错误码与 0600 独占输出继续保留。新增回归覆盖 gold sentinel、跨 scope、跨账号、旧／未批／拒绝／冲突候选、来源漂移、冻结中／查询中审批、分页、空和超长查询、预算绕过、费用边界与评分伪造。

冻结前提是专用、停止写入的隔离实验项目；两次扫描和查询前后检查**不是数据库锁或跨请求一致事务**，不声称阻止管理员 ABA 恢复／重建／恶意服务端。超过 25 个已审事实或 100 来源会拒绝，不能静默截断或合并独立分页快照。字段白名单也不能识别藏在 text 中的 gold，上游须使用 history-only loader，准备／查询进程不得挂载 gold。尚无真实 LoCoMo 抽取和人工审批清单。

可信 token counter 必须核实完整模型聊天模板；ID 一致不是正确性证明。当前未内置已验证生产 tokenizer，CLI 会 fail closed。费用预约使用显式价格，并不保证 provider 账单硬上限；不能假设缓存折扣、隐藏计费项或余额。模拟 transport 和合成 tokenizer 不构成真实 provider 测试。

## 实际验证与证据

本机 Node `v24.22.1`、Python `3.12.14`，隔离 `postgres:16` 镜像 digest `sha256:933463a6c8eba2b9f5cd414138738cd8d5519cd2c471214c222652f547a66a32`。测试只使用公开合成账号；每套创建随机临时数据库并清理。测试容器及其匿名卷已删除。未修改产品 server.js 或数据库架构。

| 检查 | 结果 | 保存证据（相对仓库根） |
| --- | --- | --- |
| Python 全部 memory tests | 68/68 | `artifacts/memory-final/python.txt` |
| core（含 adapter 单测） | 103/103 | `artifacts/system/run-1793956016144-e17e97a2/core.tap` |
| migrations | 9/9 | 同目录 `migrations.tap`、`report.json` |
| 真实 HTTP/PostgreSQL 合成 adapter 集成 | 12/12 | `artifacts/memory-final/integration.tap` |
| Node→Python evaluator 交叉验证 | 通过；1 个合成配对问题 | `artifacts/memory-final/integration/{batch,rows,score}.json` |
| 语法／compile／diff | 通过 | `node --check`、`py_compile`、`git diff --check` 退出 0 |
| 远端 CI、UI/browser、完整比赛证据打包 | 未运行 | 没有 push；本轮未改 UI |
| 独立 lint/type 项目脚本 | 未配置 | 不把未提供的检查称为通过 |

系统报告记录当时 HEAD=ceccd93、workingTreeDirty=true；那些工作区文件随后提交为 99dd46b，报告保留原始记录，没有改写成 clean-run。交付 manifest 另记录最终代码哈希并验证系统报告覆盖的源文件未改变。本轮没有做完整比赛提交证据认证。

唯一合成配对 fixture 中，memz_current 和 flat_same_facts 的 evidence recall 都为 1/1，上下文均 309 bytes，answer_accuracy=null、模型调用=0。观察到的 contextE2EMs 分别为 43.667 ms 和 27.068 ms，仅一遍未控冷／热缓存的测试读数，且与系统套件同时运行，不能做速度比结论。memz 行使用透明 HTTP 跟踪 wrapper，标记 injected_test_transport，实际请求仍到真实产品服务；其他边界测试也明确区分故障注入。完整 spans 保留在 rows.json。

模型全名、真实输入／输出 token、回答准确率、生成及回答端到端延迟、provider 缓存、费用和预处理摊销均 N/A。本任务没有发生模型调用费用，未查询账户账单。离线测试次数不是基准样本量。

复现（仓库根目录；数据库 URL 必须为可创建临时库的测试管理员，不得指向生产）：

```sh
npm ci
python3 -m unittest discover -s benchmarks/memory/tests -p 'test_*.py' -v
node --check benchmarks/memory/scripts/memz_adapter.js
node --check benchmarks/memory/tests/memz_adapter.integration.js
python3 -m py_compile benchmarks/memory/scripts/*.py benchmarks/memory/tests/*.py
SYSTEM_TEST_DATABASE_URL=... npm run test:system:evidence
MEMORY_TEST_DATABASE_URL=... MEMORY_TEST_OUTPUT=artifacts/new-memory-run npm run test:memory:integration
git diff --check
```

PostgreSQL 测试管理员实例需按 `db/schema.sql` 初始化共享 app role；临时库创建／清理由 runner 完成。系统恢复测试需 pg_dump/pg_restore 16。本云环境没有宿主工具，使用 `artifacts/pg-tools/` 中临时桥接脚本调用同一隔离容器的工具，只有公开 fixture 凭据，没有改变网络策略；该脚本未提交。CI 已添加集成命令与 Python setup，仍待以后允许 push 后执行。

阶段接口、CLI 文件格式、审批与冻结限制见 `benchmarks/memory/MEMZ_ADAPTER.md`；预算接口见 `GLM_ADAPTER.md`。未来真实实验还需数据落盘并核对哈希、安全独立解包、审阅事实包、预先封存选样清单与输入哈希、同 reader／prompt／输出预算以及经过验证的 tokenizer 和费用上限。最多约 20 道配对题属于后续计划，本次没有准备冒充真实选样的列表，也没有启动它。
