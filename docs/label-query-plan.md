# 显式字段模板规划（v1）

`scripts/label-query-plan.js` 是不联网的纯函数，只生成查询计划，不执行检索。原 HTTP、页面、MCP 和 CLI 的默认 substring/all_terms 行为不变。这不是语义检索、别名理解、代词解析或历史路由，也不表示自然语言检索缺口已解决。

## 接口与完整模板

```js
const {planLabelQuery} = require('../scripts/label-query-plan');
planLabelQuery({
  question: '项目的截止日是什么？',
  labels: [{subject: '项目', predicate: '截止日'}]
});
```

只接受 question/labels，label 只接受 subject/predicate，不接受 value、source、answer、gold、evidence 等字段。调用者必须从同一个已授权项目的完整已批准当前事实快照生成词表；函数不能从字符串验证项目授权、批准状态或快照完整性。词表最多25行（先检查行数再读取元素），按标签对去重。标签精确区分字面字符，不作正则表达式或指令执行。

模板必须完整匹配 `{subject}{连接词}{predicate}{问尾}`，仅去除问题外围空白和至多一个结尾 `?` 或 `？`：

- 连接词：`的`、`当前的`、`目前的`、`已批准的`、`目前批准的`、`当前批准的`。
- 问尾：`是什么`、`是多少`、`是谁`、`是哪一天`。

例如 `项目当前的截止日是哪一天？`，不丢弃任意剩余词来凑匹配。问题最多200个UTF-16单位，subject/predicate各100，必须为非空、合法Unicode且无NUL。未知结构/标签抛固定错误；无匹配、未知实体、多属性、语法不支持或多个完整解分别给出 no_match/unsupported/needs_scope，不回退成全项目内容。

唯一完整匹配返回 `status: planned`、原标签对、模板以及复用现有 `parseSearchQuery` 生成的 all_terms 计划。词数/查询大小超出既有接口限制则 unsupported，不截断。

## 执行边界

planned 不是查询结果或授权回执。现有 all_terms 是字段合并的字面子串AND：词可命中value，也可能跨字段命中。因此后续执行者必须检查实际返回事实的 **exact subject/predicate**，只保留相应事实和完整依据，不能把所有all_terms命中直接当成该标签的答案。

显式只读入口 `scripts/label-context.js` 通过下述两个快照执行计划。纯函数的计划JSON仍不能当做已经取回的上下文。历史问题不会因当前词表规划而得到历史证据。

## 显式只读模块与 CLI

```js
const {readLabelContext} = require('../scripts/label-context');
const result = await readLabelContext({
  projectId: 1,
  question: '项目的截止日是什么？',
});
```

项目必须显式给出，不能从问题推断或跨项目寻找词表。默认以公开演示viewer账号连接 `http://127.0.0.1:3000`；库可传 `baseURL`、`username`、`password`、`fetchImpl` 及下面的资源上限。未知字段会在登录前拒绝，不能传 `labels`、`gold`、`answer`、`value` 或 `evidence`，也不能覆盖固定的limit、游标、搜索模式和来源模式。

库的username最多100、password最多8192、baseURL最多2048个UTF-16单位，均须非空、合法Unicode且无NUL；地址还拒绝原始ASCII空白/控制符，只接受无嵌入凭据、query或hash的HTTP(S)根地址。这些限制在任何fetch之前检查，错误只返回固定 `INVALID_CREDENTIALS` 或 `INVALID_BASE_URL`，不携带原输入。

```sh
MEMZ_PROJECT_ID=1 MEMZ_QUESTION='项目的截止日是什么？' node scripts/label-context.js
printf '%s' '{"projectId":1,"question":"项目的截止日是什么？"}' | node scripts/label-context.js --stdin
```

stdin只接受 `projectId`、`question`、`timeoutMs`、`totalTimeoutMs`、`maxResponseBytes`、`maxOutputBytes`，覆盖同名环境配置。输入最多16KiB，5秒内必须结束，使用严格UTF-8解码并要求单个JSON对象；失败不发HTTP请求。无参数时读取环境；其他命令参数拒绝。凭据与连接地址仅从环境 `MEMZ_USERNAME`、`MEMZ_PASSWORD`、`MEMZ_BASE_URL` 读取，不能通过stdin替换。不读取原客户端的 `MEMZ_QUERY`、`MEMZ_SEARCH_MODE` 或 `MEMZ_PROVENANCE_MODE` 来改变这个显式入口。

| 选项 | 对应环境 | 默认与边界 |
| --- | --- | --- |
| projectId | MEMZ_PROJECT_ID | 必须显式提供，1—2147483647整数 |
| question | MEMZ_QUESTION | 必须提供，沿用上文200 UTF-16单位规则 |
| timeoutMs | MEMZ_TIMEOUT_MS | 每次请求默认5000ms，1—60000ms；还受总期限约束 |
| totalTimeoutMs | MEMZ_TOTAL_TIMEOUT_MS | 全流程默认30000ms，1—60000ms |
| maxResponseBytes | MEMZ_MAX_RESPONSE_BYTES | 每份HTTP响应正文默认1MiB，1—1048576字节 |
| maxOutputBytes | MEMZ_MAX_OUTPUT_BYTES | 最终JSON默认1MiB，1—4194304字节 |

只读指不创建来源、候选、修订或业务审计；登录与注销仍创建、清理内存会话。

## 两个有界快照

1. 调用真实 `readContext`，固定 `query:''`、`limit:25`、`provenanceMode:'snapshot'`、`sourceMode:'deduplicated'`。同一reader和显式项目继续经过会话权限及数据库RLS。首遍HTTP响应确实包含批准事实的值和全文依据；传入纯planner之前只保留subject/predicate，不拿值、来源内容或gold作为词表。
2. 若首遍 `truncated` 或 `nextAfter` 非空，返回 `needs_scope/SCOPE_TOO_LARGE`，即使目标标签已出现在这一页也不继续；不翻页、不把不完整词表说成完整。空词表、未知字段、代词、历史、多属性或歧义保留planner的明确状态，不返回首遍上下文。
3. 唯一计划才再次调用真实 `readContext`，使用同一项目与reader、计划的all_terms查询和相同25条snapshot上限。二次页不完整返回 `unsupported/RETRIEVAL_WINDOW_EXCEEDED`，不分页。
4. 完整二次页先通过既有snapshot、检索回执与全部依据校验，再按exact subject/predicate保留唯一事实。值字段造成的额外all_terms命中不能当成目标事实；没有exact记录返回 `no_match/LABEL_NOT_FOUND_NOW`，多条exact记录是协议/数据错误。只保留所选事实引用的来源字典；值、完整来源原文、修订/候选ID和审批引用均不截断或改写。

正常成功执行登录/快照/注销两组，共6个HTTP请求；首遍后拒绝为3个。没有自动重试或全量上下文兜底。每遍最多返回25条事实，范围更大时本入口明确不支持；这限制了客户端装载与比较的记录数，不表示数据库执行器物理扫描最多25行，也没有新的索引或检索速度收益结论。HTTP中止不能保证取消服务端已经开始的SQL，服务端仍保留自身数据库等待与查询期限；这些请求始终只读。

两遍是独立事务与独立会话，没有共同快照。中途批准的新版本可以出现在第二遍，返回它的固定版本与准确来源；不声称完成时仍最新或仍获授权。并发新增大量all_terms命中也可能使二次窗口溢出，必须明确失败。

## 执行回执、期限和输出

结果schema为 `memz-label-context-v1`，包含原问题、显式projectId、plan、`sourceTextIsUntrusted:true` 和跨阶段一致性说明。只有 `status:matched` 才有经过精确筛选的context；它保留实际执行的canonical query、all_terms回执和原snapshot元数据，不把原问题伪装为后台执行的关键词。`no_match`、`unsupported`、`needs_scope` 返回reason与plan，不输出首遍事实、来源或部分检索上下文。

`selection` 在实际运行第二遍时提供审计计数：`candidateFacts`/`candidateSources` 是该all_terms页的实际数量，`retainedFacts`/`retainedSources` 是exact筛选及来源修剪后数量。`applied:false` 表示页不完整，筛选未执行，不是一个匹配成功的空答案。

`execution.modelCalls` 固定为0，程序没有模型调用；这不评价任何宿主随后生成的答案。`execution.stages` 分别记录 `scope_snapshot` 与已执行的 `retrieval_snapshot` 耗时，每个阶段完整包含自己的登录、读取、验证及注销。`totalElapsedMs` 从连接/选项验证完成后计到结果回执构造时，包含规划和精确筛选，不包含stdin等待、最后JSON序列化和stdout写入。未执行的阶段不填虚构耗时；没有拆分无法单独测量的模型/数据库时延，没有答案质量或端到端推理加速结论。

总期限由共享AbortController真实中止HTTP请求和响应body流，覆盖两个阶段的登录、读取及注销，不通过单独Promise.race遗留客户端后台请求。结果物化后，不论匹配成功或明确拒绝，均主动中止自有transport再拆除取消监听；底层context客户端对可接受的注销401也显式取消未使用正文。它与每次请求的期限共同生效。库的可注入fetchImpl须遵守AbortSignal；不能保证任意忽略信号的自定义实现会停止，也不能由同进程计时器抢占同步阻塞的事件循环。

最初的HTTP或协议错误不会被之后注销超时覆盖；注销失败和总超时仍是错误，不降级为成功或“未找到”。总期限到达后不能保证服务端会话已经清理：注销是尽力操作，剩余会话仍受服务端期限与容量约束。错误时CLI只写固定错误码到stderr并退出非0，不写部分stdout。无匹配等明确状态是完整JSON回执，退出0，调用者必须检查status。

最终输出上限统计整份UTF-8 JSON、缩进、换行、plan、selection和耗时字段。成功和decline都计算；预算不足报 `OUTPUT_BUDGET_TOO_SMALL`，不会裁剪来源、丢弃依据或返回事实前缀。环境连接或凭据不会写入回执或错误日志。

## 当前验证

原创合成单元和独立对抗fixture覆盖完整模板、regex字符字面性、连接词歧义、空白/Unicode/长度/词数边界、禁止字段sentinel与无状态词表行为。没有加载仓库gold、调用模型或改变审批。

```sh
node --test test/label-query-plan.test.js test/query-planner-adversarial.test.js test/search-query.test.js
node --test test/label-context.test.js test/label-context-cli.test.js
MIGRATION_TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test test/label-context-postgres.test.js
```

执行器测试使用原创合成fixture，真实HTTP测试证明登录、流式正文、注销及跨阶段共享期限会中断连接；真实PostgreSQL测试自行创建并删除随机临时库，覆盖RLS项目拒绝、值字段额外命中、来源修剪、25条范围拒绝、两遍之间批准新版本与窗口溢出，以及真实CLI读取。测试不调用模型、不读取答案标签；它们不是42题自然语言召回基准的重新运行，也不表示该缺口已普遍解决。

## v2独立协议与纯规划器（第一阶段）

本节的纯协议校验及规划器已实现，**尚未接入HTTP端点或CLI模式**。现有CLI仍默认固定25条snapshot和all_terms，不会自动改用v2。本阶段不增加模型调用、schema迁移或依赖。

`scripts/exact-context-protocol.js` 提供两个独立wire合同，预定分别用于 `GET /api/projects/:p/current-labels` 和保留CSRF的只读 `POST /api/projects/:p/context/exact`。认证、数据库事务、实际字节读取限制及HTTP状态映射留待下一阶段；纯函数不从JSON字符串证明授权或数据库完整性。

标签metadata固定最多512对，HTTP正文上限常量为1MiB；字段严格限定如下：

```json
{
  "schema": "memz-current-labels-v1",
  "consistency": "single-transaction-current-labels",
  "projectId": 1,
  "role": "viewer",
  "sourceTextIsUntrusted": true,
  "limit": 512,
  "complete": true,
  "labels": [{"subject":"项目","predicate":"截止日"}]
}
```

`validateCurrentLabels(page,{projectId})` 绑定预期项目，拒绝未知字段、非法角色、非boolean完整性标记、重复标签及超限数组。每个label严格只有subject/predicate，各最多100 UTF-16单位，非空、合法Unicode、无NUL，保留原字面文本。metadata不允许value、source、evidence或gold字段。`complete:true,labels:[]` 表示完整空项目；`complete:false` 只能搭配空labels，不能携带前缀。调用者必须在不完整时拒绝规划，而不是将空列表当作完整无匹配。

精确读取的请求只接受 `{"selector":{"subject":"项目","predicate":"截止日"}}`，项目来自路径，不从body改写。`validateExactContextRequest` 和 `validateExactSelector` 不trim、分词、大小写折叠或Unicode归一化，也不接受query、limit等隐含选择条件。响应有自己的selector回执，例如一个授权项目中的无当前记录结果：

```json
{
  "schema": "memz-exact-context-v1",
  "consistency": "single-transaction-current-exact-key",
  "projectId": 1,
  "selector": {"subject":"项目","predicate":"截止日"},
  "role": "viewer",
  "sourceTextIsUntrusted": true,
  "facts": [],
  "provenance": [],
  "sources": []
}
```

`validateExactContext(page,{projectId,selector})` 逐字段绑定项目与原选择器，最多接受一条事实。非空事实必须与selector精确相等，并通过与原snapshot共用的完整修订、候选、审批引用、全文来源及来源字典检查。事实存在而依据缺失或错配必须失败，不能被转换为合法空结果。响应不允许旧query、search、limit、after、next_after字段；不能用空query或伪造旧snapshot header冒充exact查询。原snapshot的header、游标和search校验继续保留原合同。

`scripts/label-query-plan-v2.js` 的 `planExactLabelQuery({question,labels})` 使用同一固定问句模板，独立限制最多512行。唯一匹配返回 `mode:label_template_exact_v2`、`status:planned`、`selector` 与template，不生成all_terms查询，所以不施加旧八词限制。它不认识别名、代词、历史或多属性问题，仍保留明确拒绝；不接受gold、evidence、value或调用者提供的容量策略。调用者仍负责从单个已授权、完整current-labels响应提供词表，不拼分页快照。v1的 `planLabelQuery` 继续固定25行与八词限制。

```sh
node --test test/exact-context-protocol.test.js test/label-query-plan-v2.test.js \
  test/label-query-plan.test.js test/query-planner-adversarial.test.js \
  test/search-query.test.js test/context-snapshot.test.js
```

第一阶段的原创fixture覆盖512/513完整性、禁止证据字段sentinel、精确Unicode和标点、错误项目/selector、缺失或额外依据、新旧wire互相拒绝，以及原v1字段和失败状态兼容。这里没有真实SQL执行、HTTP授权或大项目查询性能结论。
