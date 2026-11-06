# 单请求快照上下文

本轮选择增加显式可选的 `provenanceMode='snapshot'`，把一页当前事实、该页确切修订的完整依据和来源表放在一次 HTTP 请求中读取。默认 `individual` 及已有 `batch` 保持兼容，`sourceMode` 仍独立决定最终输出格式。本设计只涉及读取路径，不改变审批、事实版本、来源原文或数据库结构。

设计核查基线为 `cb374f21c409f82d78b5af2e87df2f433f91d694`。研究和代码评审不构成性能实验或模型质量证明；本轮不运行完整 benchmark 或外部模型。实现及回归结果以对应测试记录为准。

## 选择理由与候选比较

| 方向 | 价值 | 复杂度与范围 | 主要风险 / 决定 |
| --- | --- | --- | --- |
| 单请求快照上下文 | 减少页与依据之间的 HTTP 往返；在 HTTP 响应中去重来源；明确单页事务视图 | 中低；新增只读端点、客户端分支、合同测试，无迁移 | 响应体有界、严格验证新格式、避免扩大一致性承诺；本轮选择 |
| 带确定性来源定位的候选导入 | 让负责人能核对候选对应的原文片段，补强未来提取 adapter | 中高；需定义偏移编码、来源首尾 trim 后的位置、重复片段、来源哈希、定位持久化及两步写入恢复 | 片段存在不证明候选语义成立，不能自动批准；独立后续任务 |
| 预算早停读取 | 紧预算时避免读取后续不会输出的依据 | 中；需改变读取调度并重新定义失败边界 | 当前合同要求被预算省略的依据也先验证；早停会改变此行为，不与本轮合并 |

已有 `facts` 页在 REPEATABLE READ 事务中读取，后续依据请求又明确固定 `fact.id + version`。因此现有实现本来就能在并发批准后返回原版本的正确内容。本改动不修复一个不存在的“事实和依据混版”问题，也不承诺回答更正确。

真实增量是把分页事实、依据及项目角色读取放入同一数据库事务，省去单独事实页请求，并把重复来源从 HTTP 响应中移除。对于正常完成且 N≤25 的非空页，已有 batch 为登录、facts、provenance、注销共4次请求，snapshot 为登录、context、注销共3次；空页二者均为3次。请求数是代码路径性质，不是实测时延或固定加速比。

`sourceMode='deduplicated'` 原来仅对客户端最终输出去重，旧 batch 的网络正文仍重复携带来源。新端点始终用来源表传输，客户端可再输出 inline 或 deduplicated。本次实现也将完整来源查询分离出来，使用本页唯一 sourceId 集合读取，每份正文只从该查询返回一次；没有测量数据库协议流量或扫描成本，不能从这一结构推导 SQL 加速。唯一来源、短文本及空页仍可能因包装元数据出现字节开销。

## 固定研究依据

[前轮研究报告](../benchmarks/memory/RESEARCH_UPDATE_2026-11-06.md) 将传输聚合、来源去重、预算策略和语义检索分别消融。本轮沿用该边界，不扩展为向量检索或模型抽取。

OpenViking 固定提交 `739e17f9172b9f595bfe4cc95293ec52d4686120` 的 [context pipeline](https://github.com/volcengine/OpenViking/blob/739e17f9172b9f595bfe4cc95293ec52d4686120/openviking/retrieve/context_assembler/pipeline.py) 将上下文获取和装配集中在请求路径；[分层文档](https://github.com/volcengine/OpenViking/blob/739e17f9172b9f595bfe4cc95293ec52d4686120/docs/en/concepts/03-context-layers.md) 区分摘要导航与完整内容。这支持显式区分读取合同的设计思路，但不是本接口的性能证明。本项目独立实现，不导入其 AGPL 源码，也不借用摘要替代完整依据。

## HTTP 合同

新增 `GET /api/projects/:p/context`，使用既有登录会话、Host 限制、应用数据库角色及 RLS。GET 不执行写入，不提供批准能力。

| 参数 | 合同 |
| --- | --- |
| `limit` | 默认25，整数1—25；大于25拒绝，不截成25，也不自动拆成多请求 |
| `q` | 与 facts 接口相同的查询字段及校验；substring 保留既有兼容规则 |
| `match` | 默认 substring；显式 all_terms 沿用现有 [多词检索合同](lexical-retrieval.md) |
| `after` | 默认0，既有事实 ID 游标；仍按 fact.id 升序 |

响应的固定标识为 `schema:'memz-context-snapshot-v1'`、`consistency:'single-page-repeatable-read'`，并回显 `projectId/query/limit/after`（包括 `after:0`）。其余字段包括：

- `role`、`sourceTextIsUntrusted:true`。
- `facts`：当前匹配事实页，最多25项，按 ID 升序；每项包含 `id/subject/predicate/version/value/revisionId/sourceId`。后两个字段来自当前 revision，作为核对 proof 的独立锚点；不重复携带来源标题或正文。
- `provenance`：与 facts 逐项同序的完整修订、候选及审批引用；每项以 `sourceId` 替换旧 proof 的内联 `source`，其他依据字段保留。
- `sources`：每个被返回事实引用的来源 ID 恰好一次，含完整 `id/title/content`，按首次引用顺序排列；相同标题或相同正文的不同 ID 仍是不同来源。
- `next_after`：与既有分页相同；all_terms 时另含原 `search` 回执。

空结果的三个数组均为空，游标为空。为判断是否有下一页而读取的第26项只用于分页探测，其 proof 和来源不得进入响应。source 集合只包含实际返回事实所引用的来源。

响应在事务成功提交后发送；任一查询或组装失败都不发送部分页或部分依据。明确项目角色检查和行安全约束位于同一事务内，SQL 连接应保持项目归属与确切修订关系。此处“同一权限视图”不表示每行 RLS 只执行一次。

25条上限同时约束读取工作量和最大合法字段的 JSON 响应。字符数不能直接当字节数：控制字符可编码成六字节转义，中文、emoji 和 JSON 包装也占空间。客户端继续执行默认1 MiB的逐块 HTTP 响应上限；调用者降低 `maxResponseBytes` 后，合法页仍可能因过大失败。

当前数据库字段本身没有应用长度上限的 CHECK，不能仅凭25条就宣称任意管理员直接写入的超长数据也保证小于1 MiB。新端点对实际序列化 wire JSON 再做1 MiB上限检查；超出返回固定500错误，不输出部分内容。测试还应覆盖完整响应的转义最坏情况；不能以截断来源原文来满足上限。

## 客户端与 CLI 合同

库调用示例：

```js
const {readContext}=require('../scripts/context-client');
const context=await readContext({
  query:'截止日 项目',
  searchMode:'all_terms',
  provenanceMode:'snapshot',
  sourceMode:'deduplicated',
  limit:25,
  maxOutputBytes:12000,
});
```

标准输入与环境配置沿用既有入口：

```sh
printf '%s' '{"projectId":1,"query":"项目","provenanceMode":"snapshot","sourceMode":"deduplicated","limit":25}' | node scripts/context-client.js --stdin
MEMZ_PROVENANCE_MODE=snapshot MEMZ_QUERY=项目 MEMZ_LIMIT=25 npm run --silent demo:context
```

stdin 显式配置覆盖环境配置，仍不接收凭据或服务地址。snapshot 模式下 `limit>25` 在登录前返回 `INVALID_SNAPSHOT_LIMIT`；不能为了满足旧客户端最多100条的范围自动拆页，然后继续声称单次快照。旧 individual/batch 的最多100条合同保留。

snapshot 只向新端点读取一次上下文数据，不再先取 facts 或发 provenance 请求。客户端必须验证格式/一致性标识、请求回显、角色、不可信数据标记、事实数量及 ID 顺序、游标、search 回执、proof 同序及版本内容匹配、revisionId/sourceId 锚点、来源 ID 唯一性和引用闭合。缺失来源、重复来源、额外未引用来源、错位依据、错误版本或不符的模式回执都不得静默接受；snapshot 协议错误返回 `INVALID_SNAPSHOT_RESPONSE`。这些检查验证响应内部一致性，不是密码学来源认证。

端点不存在、响应格式错误、超限或超时均失败，并按原合同尝试注销；不自动回退旧接口。自动回退会让调用者误以为获得了新保证。

`sourceMode='inline'` 仍输出 schemaVersion 1 和每事实完整 source；`deduplicated` 仍输出 schemaVersion 2、每事实 sourceId 和顶层 sources。snapshot 模式的最终输出另外包含 `snapshot:{schema:'memz-context-snapshot-v1',consistency:'single-page-repeatable-read'}`，其字节计入预算；顶层 `consistency` 说明明确标注单页事务视图、完成时不保证仍为最新或仍有权限、续读建立新快照。默认路径的输出合同不被顺带改写。

所有返回 proof 和 source 先验证，再执行现有 `maxOutputBytes`。预算按完整序列化 UTF-8 JSON取最大完整事实前缀，包含 envelope、元数据及对应完整来源，不跳过大项、不截原文；首项放不下仍失败。即使某项最后会被预算省略，它的无效依据仍使整次读取失败。预算裁剪属于输出装配，不表示减少了本页服务器读取。

## REPEATABLE READ、权限与时间边界

PostgreSQL 16 的 REPEATABLE READ 为同事务内的后续查询提供相同视图，快照由首个非事务控制语句建立。现有事务辅助函数先执行 `SELECT set_config(...)` 设置身份，因此不要把快照时间说成“HTTP 请求到达时刻”“角色检查时刻”或“响应完成时刻”。本接口无需导出数据库 snapshot、长期保留事务或发放可续用的快照令牌。[PostgreSQL 16 事务隔离](https://www.postgresql.org/docs/16/transaction-iso.html#XACT-REPEATABLE-READ)

RLS 继续使用应用角色及项目 membership。新端点不禁用策略、不用超级用户或 BYPASSRLS，也不增加 SECURITY DEFINER 查询包装。角色和数据在同一事务视图中判断，代表该视图中的可见性，不代表管理员在请求进行中撤销权限会立即中断已经开始的读取。登录会话位于应用内存，也不属于 PostgreSQL 快照；不要把所有认证状态都说成单一数据库快照。[PostgreSQL 16 行安全策略](https://www.postgresql.org/docs/16/ddl-rowsecurity.html)

返回的 revision 是该页快照中已批准的当前版本，不保证完成时仍最新。按 `nextAfter` 续读会重新登录并建立新事务；跨页可能遇到新增事实和后续批准，仍沿用 [分页限制](context-client.md)。“snapshot”仅作用于本次页，不是整个项目导出、会话持续快照或任意历史时刻查询。

完整来源仍是不可信文本。单事务读取、批准状态和来源定位均不能把其中的指令升级为可信指令，也不证明候选描述客观正确。

## 验收与测试策略

以下是实现应满足的验收项，不是本设计文档自行宣称已经通过的结果：

1. **兼容与逻辑等价**：冻结合成数据后，与旧 individual/batch 比较完整事实、revision/candidate/审批引用和原文；inline 与 deduplicated 可无损互相重建。默认路径保持旧输出。
2. **边界与资源**：空页、1/25条、limit26拒绝；中文、emoji、引号、反斜杠及控制字符下核对实际响应字节；更小响应限额仍失败，不自动拆批或回退。
3. **来源与探测行**：共享来源只传一次；不同 ID 同正文不合并；第26行特有来源不输出；空页无 sources；来源重复、缺失、额外项和引用错配失败。
4. **检索与分页**：substring/all_terms 结果和回执保持；按 fact.id 顺序；预算恰好边界/少一字节、首项过大、共享来源、新来源以及续读，保留完整前缀。
5. **权限和失败**：未登录、非成员、跨项目、数据库失败、响应篡改与超时，无部分依据输出，并验证成功/失败后的注销。证明查询继续经过真实应用角色的 RLS。
6. **事务并发**：用确定性同步点使并发批准发生在同一读取事务的两次查询之间，证明后续证据仍来自该事务视图。若实际实现只用一次联合 SELECT，测试其读取前后版本边界即可，不虚构跨查询竞态；不要用不稳定 sleep 代替同步。
7. **请求合同**：正常 snapshot 为登录/context/注销3次；既有 batch 非空25条为4次，默认 individual 为 N+3次。只断言结构性次数，不设置虚构性能阈值；实际延迟和模型质量留给后续独立评估。

本轮只在云任务本地实现与必要回归范围内工作。提交、推送、合并和部署均暂停；此文档不构成恢复发布的授权。

## 本地验证记录（2026-11-06 UTC）

以下是基于 `cb374f21c409f82d78b5af2e87df2f433f91d694` 的**未提交工作树**检查，不是该远端提交的 CI 结果。环境为 Node 24.19.0、PostgreSQL 16.15；测试使用独立临时数据库，完成后确认清理。

| 检查 | 实际结果 |
| --- | --- |
| 完整核心测试，包括新快照协议、真实 PostgreSQL/RLS、并发与 CLI | 95/95 通过 |
| 旧库迁移与迁移后集成流程 | 9/9 通过 |
| 既有合成检索正确性用例 | 19/19 通过 |
| 真实 Chromium UI 回归 | 通过 |
| 新旧客户端与多词协议的独立测试子集 | 28/28 通过（包含于核心检查，不累加） |
| JavaScript 语法与 diff 空白检查、独立代码/测试复核 | 通过；复核未发现阻塞性问题 |

并发回归先在原连接建立事实页视图，等待另一个真实 owner 请求提交新版本，再从原连接额外读取当前事实及 `transaction_isolation`、`transaction_read_only`、`pg_current_snapshot()`。原连接仍得到 v2、repeatable read、on 和相同 snapshot；独立新请求得到 v3 及新来源。因此这项检查能区分 READ COMMITTED，不只是再次验证固定旧版依据。缺少事实/候选/来源与超大响应的500路径采用明确的查询结果故障注入，没有破坏存储内容。

另在冻结的**三个合成事实共享一份来源**上，实际包装原生 fetch 统计一次完整读取（含登录和注销）的响应正文。三种模式均使用 all_terms 和最终 deduplicated 输出；将结果展开为内联事实后，值、修订、审批引用和来源逐字段相同。

| provenanceMode | HTTP 请求数 | HTTP 响应正文总字节 |
| --- | ---: | ---: |
| individual | 6 | 28,396 |
| batch | 4 | 28,460 |
| snapshot | 3 | 10,932 |

这些是该合成 fixture 的实际 UTF-8 响应正文字节，不含请求正文、HTTP 头、TLS、压缩或数据库协议开销；不是 tokenizer token、计费 token、延迟或模型质量成绩。新元数据会增加最终输出开销，来源不共享时也不保证省字节。25份不同来源和最长合法字段的控制字符转义极限另由协议测试验证，仍小于默认1 MiB响应限制。

本地原始证据位于以下被 Git 忽略的路径，工作树状态与源码哈希保留在报告内：

- `artifacts/system/run-1793948036354-0f435806/report.json` 及同目录 `core.tap`、`migrations.tap`；上述传输数据来自 `core.tap`。
- `artifacts/retrieval-report.json`。
- `artifacts/ui/run-1793948073398-57326774/report.json` 及截图。

在已初始化应用角色的**专用测试 PostgreSQL** 上设置管理员连接后，可复现必要检查。下列变量均指向测试实例；runner 会创建随机临时数据库，不重置传入数据库。容器中的 PostgreSQL 工具可通过既有 `PG_TOOLS_CONTAINER` 配置给备份/恢复回归使用。

```sh
SYSTEM_TEST_DATABASE_URL="$TEST_DATABASE_URL" npm run test:system:evidence
EVALUATION_DATABASE_URL="$TEST_DATABASE_URL" npm run eval:retrieval
UI_TEST_DATABASE_URL="$TEST_DATABASE_URL" CHROMIUM_PATH=/usr/bin/chromium npm run test:ui:evidence
```

本轮没有运行完整 benchmark、外部模型、第三方系统对照或 `eval:context` 延迟实验，也没有运行需要干净已提交源码的发布材料打包。本地未提交改动没有新的 GitHub CI；原有准备脚本、模型适配器和四组实验入口仍保留，未据此推断真实模型收益。
