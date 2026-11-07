# 有界的真实 memz 实验适配器

`scripts/memz_adapter.js` 默认调用本项目真实 HTTP 服务与 `scripts/context-client.js`，不使用 BM25 充当 memz，不调用模型。`memz_score.py` 是单独的 evaluator，只有它接收 gold。数据库／HTTP 集成使用明确的合成 fixture；产品真实路径验证不等于 LoCoMo 或模型回答质量实测。

## 阶段与审批边界

1. `prepareHistory({scope, documents})` 只接受规范化历史。每个 document 精确包含 `id/session_id/date/text`，未知字段包括问题、gold、answer、category、evidence 一律拒绝。保留原文哈希，不读取旁边的 gold 文件。字段隔离不能识别被伪装进普通 text 的标签；上游必须使用已审查的 history-only loader，并在运行隔离中不给准备／查询进程挂载 gold。
2. `ingestHistory(prepared, {baseURL, projectId}, writer)` 通过真实来源 API 写入来源，并返回稳定幂等键对应的 ID／内容哈希映射。它不创建候选、不批准事实。来源首尾空白按现有产品规则 trim，原文保留在 prepared；超过 4000 UTF-16 单位的文档拒绝，不截断、不自动分块。部分失败返回已完成回执和 unknown/rejected/not_attempted 状态；不自动重试或删除。
3. 人工／独立提取流程可对来源提出候选，由产品现有负责人显式批准。适配器没有 approve 方法。这个阶段必须在看到测试问题、答案和 evidence 标签之前完成；真实提取和人工审批费用／时间由操作者另行记录，不能当作免费。
4. `freezeApproved(ingested, reader)` 读取真实获批版本和全部来源，核对它们属于导入清单，连续读取两遍验证稳定后封存 scope、项目、只读主体、版本、修订／候选／批准者、来源及 SHA256。产物不可自动批准，也不表示事实客观正确。
5. `queryFrozen(frozen, query, reader, options)` 只接受 `id/scope/question` 与可选 date；query 无权覆盖项目、用户、地址或检索策略。`memz_current` 将完整问题原文交给真实 `/context` 的 substring 检索；超过 200 UTF-16 单位直接保留失败行，不改写关键词。`flat_same_facts` 在同一获批事实集上按字面子串筛选。两者使用相同渲染格式和上下文字节上限。reader 请求 ID 加 method 后缀，防止配对组重复 ID。
6. `memz_score.py` 独立校验 frozen／query／context 哈希、事实与来源投影、provenance，再计算严格 evidence 指标。缺失或失败的行仍进入配对分母，空 evidence 为 N/A，无法解析的 evidence 不修复。答案字段不参与检索；evidence 命中不是答案正确率。

程序化 query 在序列化和读取字段值前先检查全部自有字段及其描述符：未知字段（含不可枚举字段）和 accessor 均拒绝，不调用 gold、evidence、id 或 question getter。错误行的可选 id 也只从自有 data property 取得。随后仅复制允许的字段并验证字符串/scope；不会通过 `toJSON` 或 getter 把标签变成问题。此保护针对模块的普通对象输入，不是恶意 JavaScript Proxy 的执行沙箱，也无法识别藏在合法问题文本中的答案；CLI JSON隔离及独立gold挂载要求仍保留。

同样的边界现覆盖 prepare 历史、ingest 的 prepared、freeze 的 ingested，以及 query 的 frozen artifact：先按各阶段现有有限 schema 检查全部自有字段描述符，再复制白名单 data property 和数组索引，最后才做 canonical clone/hash。未知 own 字段（包括隐藏字段、Symbol、own `toJSON`）和 accessor 在取值前拒绝；数组不能靠额外属性、索引 getter 或 toJSON 混入标签。嵌套 document、来源映射、binding、冻结事实/来源也遵循同一顺序；baseURL 必须先是字符串才会交给 URL 解析，不能执行对象的 toString。非法输入不会先被 JSON 丢字段再进入来源写入，查询仍保留固定错误行和 modelCalls=0。

快照仅按明确的 artifact 结构复制，没有通用递归序列化器或全局“已见对象”去重；普通 JSON 可表达的共享来源引用仍可接受，并与独立副本保持相同字节/hash，真正的循环结构在有限 schema/类型检查处拒绝。正常 JSON 的产物、来源哈希、幂等键和认证/HTTP 请求顺序保持；公共 `canonical/hash/seal` 工具原样保留，调用者应只把已验证的可信数据交给这些工具。writer、fetchImpl 等运行配置仍是可信调用控制面；这里不承诺抵御恶意 Proxy、全局 prototype 修改或同进程任意 JavaScript 执行，也不替代 gold 挂载隔离。

## 冻结边界

首版要求每个 scope 使用**专用项目和停止写入的隔离实验服务**。服务需要事先配置项目与 membership；适配器不借管理员凭据自动创建项目。一个项目最多 25 个获批事实、100 个来源，来源集合必须精确对应导入清单。普通客户端源文本不可修改，但 adapter 仍检测来源内容变化、新来源、新事实及版本／溯源漂移。

产品每个 `/context` 或 `/sources` 请求有自己的快照。这里不把分页拼起来声称共同快照：任何 `next_after`、重复／倒退来源 ID、超额响应、权限或非法回执都失败。冻结的两次扫描、查询前后各一次完整状态核对用于发现漂移；它们**不是数据库写锁或跨请求事务**，无法抵御管理员改写后恢复的 ABA 操作、数据库重建或恶意服务端。保持实验实例只读是有效性前提。超过规模上限必须单独设计更大范围冻结协议，不能删除来源或事实凑数。

两种查询方法都先以当前 reader 重新认证并验证完整冻结状态，结束前再次检查；这样不会因 flat 读缓存而跨账号泄漏。`memz_current` 额外通过产品 query snapshot 读取匹配项并比对固定版本；批准发生在查询中途时整行失败，不输出部分上下文。没有命中仍保留空事实行。保存产物使用 0600、独占写入；本地 JSON/hash 是可审计证据，不是对能改文件的同一 OS 用户的认证边界。

## 计量与公平性

逐行记录 `contextE2EMs`，从收到 query 到完成冻结检查、认证、检索、溯源、来源检查和序列化。每次完整 read 的 span 包含登录、正文读取、验证与注销；认证会话不跨 query 共用。`memz_current` 正常读取 15 次 HTTP 请求，flat 12 次，差异源于实际产品查询；双方的冻结验证开销都计入，不能偷偷从 memz 端到端结果里扣掉。全部失败保留 error/spans，模型 usage、generation、answerE2E 和 answerQuality 保持 null。

source/prepare/freeze 的耗时单独返回，尚无 LLM 抽取、人工审批计时器或摊销结论。CLI 配对顺序由 `sha256(["42", question_id])` 决定，固定最多 20 题；题目选择由上游封存清单决定，没有声称随机均衡抽样。flat 使用 JS `toLowerCase`，产品使用 PostgreSQL `lower`；Unicode/locale 的差异应作为限制，不能把它称为 SQL 的完全复现。当前没有 provider 缓存、冷／热生成或真实费用数据。

## 接口与运行

模块 API 可在独立的准备／查询进程使用：

```js
const {prepareHistory, ingestHistory, freezeApproved, queryFrozen} = require('./benchmarks/memory/scripts/memz_adapter');
const prepared = prepareHistory(historyOnly); // 无 query/gold 挂载
const imported = await ingestHistory(prepared, {baseURL, projectId}, writer);
// 检查 status，保存 imported.artifact；由负责人独立审阅并批准候选。
const frozen = await freezeApproved(imported.artifact, reader);
// 检查 status，保存 frozen.artifact；在查询进程只加载它和封存 query 清单。
const row = await queryFrozen(frozen.artifact, query, reader, {method: 'memz_current'});
```

`writer/reader` 使用现有产品登录配置（非模型 key）。示例不包含凭据；生产默认 transport 是真实 HTTP。`fetchImpl` 只用于受信测试插桩，使用时输出标记 `injected_test_transport`，不能当作独立服务证据。

CLI 接收阶段、输入文件、全新输出文件三个参数：

```sh
node benchmarks/memory/scripts/memz_adapter.js prepare history-only.json prepared.json
MEMZ_PROJECT_ID=3 node benchmarks/memory/scripts/memz_adapter.js ingest prepared.json import-result.json
# 保存 import-result.json 中的 artifact 为 imported.json，完成外部显式审批后：
node benchmarks/memory/scripts/memz_adapter.js freeze imported.json freeze-result.json
# query-batch.json 是 {"frozen": <freeze-result.artifact>, "queries": [...]}，不含 gold：
node benchmarks/memory/scripts/memz_adapter.js query query-batch.json query-rows.json
# 仅 evaluator 挂载 gold：
python3 benchmarks/memory/scripts/memz_score.py --batch query-batch.json \
  --rows query-rows.json --gold gold.private.jsonl --output retrieval-score.json
```

CLI 的 `MEMZ_BASE_URL`、`MEMZ_PROJECT_ID` 仅用于来源导入绑定。freeze/query 使用已封存的本机地址和项目。用户名／密码由 `MEMZ_USERNAME`、`MEMZ_PASSWORD` 提供；未设置时为公开合成 member（导入）或 viewer（读取）账号。输入文件最多 4 MiB，不能为符号链接；输出不覆盖，错误不打印原文、密码、cookie 或服务响应体。prepare 输出是 artifact；ingest/freeze 输出为状态回执包装，必须只在成功后取 `.artifact` 交给下一阶段。

## 验证与尚缺的依赖

```sh
node --test test/memory-adapter.test.js
python3 -m unittest discover -s benchmarks/memory/tests -p 'test_*.py' -v
# 需要已初始化、可创建临时库的测试 PostgreSQL（不得指向生产）：
MEMORY_TEST_DATABASE_URL=... MEMORY_TEST_OUTPUT=artifacts/memory-adapter \
  npm run test:memory:integration
```

真实集成测试创建随机临时数据库、真实 Express 服务和 HTTP 来源／候选／审批，结束清理临时库与服务。其中专门的故障测试会对真实 HTTP 回执注入错误或以 schema owner 改动合成来源，名称明确标注；不把这些故障注入当作自然生产故障。evaluator 交叉验证使用实际 Node 输出和 Python 评分，gold sentinel 在 reader 完成后才创建。

真实模型运行仍需已注入的可用凭据、确定模型、经过核实的完整 chat tokenizer、价格／积分计量与明确运行预算。`glm_adapter.py` 的生产 Python 入口和 CLI 都强制 spend guard；只有显式 `simulation=True` 且提供测试 transport 才允许无 guard 模拟，它不读取真实凭据，并标记 execution_mode。本任务没有真实 LoCoMo 数据、真实模型、自动抽取／审批或答案质量实验。
