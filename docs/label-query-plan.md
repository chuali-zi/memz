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

项目必须显式给出，不能从问题推断或跨项目寻找词表。默认以公开演示viewer账号连接 `http://127.0.0.1:3000`；库可传 `baseURL`、`username`、`password`、`fetchImpl`、受控protocol及下面的资源上限。未知字段会在登录前拒绝，不能传 `labels`、`selector`、`gold`、`answer`、`value` 或 `evidence`，也不能覆盖固定的limit、游标、搜索模式和来源模式。

库的username最多100、password最多8192、baseURL最多2048个UTF-16单位，均须非空、合法Unicode且无NUL；地址还拒绝原始ASCII空白/控制符，只接受无嵌入凭据、query或hash的HTTP(S)根地址。这些限制在任何fetch之前检查，错误只返回固定 `INVALID_CREDENTIALS` 或 `INVALID_BASE_URL`，不携带原输入。

`readContext` 和 `readLabelContext` 的模块参数另可接受 `signal: controller.signal`，类型须为原生AbortSignal；非法类型在HTTP前报 `INVALID_SIGNAL`，预取消为零HTTP并报 `REQUEST_CANCELLED`。它不是stdin字段，两个CLI都会拒绝stdin中的signal；也不读取或转换 `MEMZ_SIGNAL` 等环境文本。signal及其reason不写入结果或错误，取消不会抛出调用者提供的原reason。

```sh
MEMZ_PROJECT_ID=1 MEMZ_QUESTION='项目的截止日是什么？' node scripts/label-context.js
printf '%s' '{"projectId":1,"question":"项目的截止日是什么？"}' | node scripts/label-context.js --stdin
# 显式选择512标签/精确依据协议；原命令默认仍为v1。
MEMZ_LABEL_PROTOCOL=metadata_exact_v2 MEMZ_PROJECT_ID=1 MEMZ_QUESTION='项目的截止日是什么？' node scripts/label-context.js
printf '%s' '{"projectId":1,"question":"项目的截止日是什么？","protocol":"metadata_exact_v2"}' | node scripts/label-context.js --stdin
```

stdin只接受 `projectId`、`question`、`protocol`、`timeoutMs`、`totalTimeoutMs`、`maxResponseBytes`、`maxOutputBytes`，覆盖同名环境配置。输入最多16KiB，5秒内必须结束，使用严格UTF-8解码并要求单个JSON对象；失败不发HTTP请求。无参数时读取环境；其他命令参数拒绝。凭据与连接地址仅从环境 `MEMZ_USERNAME`、`MEMZ_PASSWORD`、`MEMZ_BASE_URL` 读取，不能通过stdin替换。不读取原客户端的 `MEMZ_QUERY`、`MEMZ_SEARCH_MODE` 或 `MEMZ_PROVENANCE_MODE` 来改变这个显式入口。

| 选项 | 对应环境 | 默认与边界 |
| --- | --- | --- |
| projectId | MEMZ_PROJECT_ID | 必须显式提供，1—2147483647整数 |
| question | MEMZ_QUESTION | 必须提供；默认snapshot_filter_v1最多200个UTF-16单位，显式metadata_exact_v2最多210；先限制原始长度再去外围空白 |
| protocol | MEMZ_LABEL_PROTOCOL | 默认snapshot_filter_v1；只可显式选择metadata_exact_v2或snapshot_filter_v1，其他值在HTTP之前拒绝 |
| timeoutMs | MEMZ_TIMEOUT_MS | 每次请求默认5000ms，1—60000ms；还受总期限约束 |
| totalTimeoutMs | MEMZ_TOTAL_TIMEOUT_MS | 全流程默认30000ms，1—60000ms |
| maxResponseBytes | MEMZ_MAX_RESPONSE_BYTES | 每份HTTP响应正文默认1MiB，1—1048576字节 |
| maxOutputBytes | MEMZ_MAX_OUTPUT_BYTES | 最终JSON默认1MiB，1—4194304字节 |

只读指不创建来源、候选、修订或业务审计；登录与注销仍创建、清理内存会话。

## 默认v1的两个有界快照

1. 调用真实 `readContext`，固定 `query:''`、`limit:25`、`provenanceMode:'snapshot'`、`sourceMode:'deduplicated'`。同一reader和显式项目继续经过会话权限及数据库RLS。首遍HTTP响应确实包含批准事实的值和全文依据；传入纯planner之前只保留subject/predicate，不拿值、来源内容或gold作为词表。
2. 若首遍 `truncated` 或 `nextAfter` 非空，返回 `needs_scope/SCOPE_TOO_LARGE`，即使目标标签已出现在这一页也不继续；不翻页、不把不完整词表说成完整。空词表、未知字段、代词、历史、多属性或歧义保留planner的明确状态，不返回首遍上下文。
3. 唯一计划才再次调用真实 `readContext`，使用同一项目与reader、计划的all_terms查询和相同25条snapshot上限。二次页不完整返回 `unsupported/RETRIEVAL_WINDOW_EXCEEDED`，不分页。
4. 完整二次页先通过既有snapshot、检索回执与全部依据校验，再按exact subject/predicate保留唯一事实。值字段造成的额外all_terms命中不能当成目标事实；没有exact记录返回 `no_match/LABEL_NOT_FOUND_NOW`，多条exact记录是协议/数据错误。只保留所选事实引用的来源字典；值、完整来源原文、修订/候选ID和审批引用均不截断或改写。

正常成功执行登录/快照/注销两组，共6个HTTP请求；首遍后拒绝为3个。没有自动重试或全量上下文兜底。每遍最多返回25条事实，范围更大时本入口明确不支持；这限制了客户端装载与比较的记录数，不表示数据库执行器物理扫描最多25行，也没有新的索引或检索速度收益结论。HTTP中止不能保证取消服务端已经开始的SQL，服务端仍保留自身数据库等待与查询期限；这些请求始终只读。

两遍是独立事务与独立会话，没有共同快照。中途批准的新版本可以出现在第二遍，返回它的固定版本与准确来源；不声称完成时仍最新或仍获授权。并发新增大量all_terms命中也可能使二次窗口溢出，必须明确失败。

## 执行回执、期限和输出

默认结果schema为 `memz-label-context-v1`，包含原问题、显式projectId、plan、`sourceTextIsUntrusted:true` 和跨阶段一致性说明。只有 `status:matched` 才有经过精确筛选的context；它保留实际执行的canonical query、all_terms回执和原snapshot元数据，不把原问题伪装为后台执行的关键词。`no_match`、`unsupported`、`needs_scope` 返回reason与plan，不输出首遍事实、来源或部分检索上下文。v2使用下文的独立schema和exact wire，不伪造v1的query/search字段。

`selection` 在实际运行第二遍时提供审计计数：v1的 `candidateFacts`/`candidateSources` 是该all_terms页的实际数量，`retainedFacts`/`retainedSources` 是exact筛选及来源修剪后数量。`applied:false` 表示页不完整，筛选未执行，不是一个匹配成功的空答案。v2由服务端直接按唯一键选择，计数是完整exact响应中的0或1条事实及来源，不是all_terms候选或相关性评分。

`execution.modelCalls` 固定为0，程序没有模型调用；这不评价任何宿主随后生成的答案。v1的 `execution.stages` 分别记录 `scope_snapshot` 与已执行的 `retrieval_snapshot` 耗时，每个阶段完整包含自己的登录、读取、验证及注销。v2只有 `metadata_exact_session`，完整包含一次登录、metadata读取及验证、模板规划、执行时才有的exact读取及验证、注销；不把这两次独立数据库事务误叫共同快照。`totalElapsedMs` 从连接/选项验证完成后计到结果回执构造时，包含规划和精确筛选，不包含stdin等待、最后JSON序列化和stdout写入。未执行的阶段不填虚构耗时；没有拆分无法单独测量的模型/数据库时延，没有答案质量或端到端推理加速结论。

总期限由共享AbortController真实中止HTTP请求和响应body流，覆盖v1的两个会话或v2的一次登录/两次读取/注销，不通过单独Promise.race遗留客户端后台请求。结果物化后，不论匹配成功或明确拒绝，均主动中止自有transport再拆除取消监听。共享内部 `read-session.js` 对可接受的注销401及其他非2xx响应显式取消未使用正文，并在每次请求finally中止自有transport；失败正文取消异常不覆盖原HTTP错误，超限正文取消异常也不覆盖 `RESPONSE_TOO_LARGE`。原readContext的公开参数、header和正常输出不变，原有独立尽力注销时间规则不变；label读取入口另外用自己的全流程期限覆盖注销。它与每次请求的期限共同生效。库的可注入fetchImpl须遵守AbortSignal；不能保证任意忽略信号的自定义实现会停止，也不能由同进程计时器抢占同步阻塞的事件循环。

最初的HTTP或协议错误不会被之后注销超时覆盖；注销失败和总超时仍是错误，不降级为成功或“未找到”。总期限到达后不能保证服务端会话已经清理：注销是尽力操作，剩余会话仍受服务端期限与容量约束。错误时CLI只写固定错误码到stderr并退出非0，不写部分stdout。无匹配等明确状态是完整JSON回执，退出0，调用者必须检查status。

调用者signal只中止业务登录和读取，包括等待headers及消费body；取消后不再开始后续读取。已取得有效cookie/CSRF的会话仍执行尽力注销，caller signal不会中止该注销。注销受原有独立 `min(timeoutMs,5000)` 清理期限约束，label入口还受全流程总budget约束，不能无限延长。若取消发生时登录尚未取得完整有效凭据，不能保证清理服务端可能已创建的会话，且不会继续读取。成功数据返回前再次检查caller状态，取消即使发生在已完成读取后的注销期间，也不返回成功数据。正常取消固定为 `REQUEST_CANCELLED`；若更早已经发生HTTP、协议或资源主错误，则保留该主错误，不让后续清理异常或取消reason覆盖它。未传signal的v1/v2输出schema及HTTP序列不变。

最终输出上限统计整份UTF-8 JSON、缩进、换行、plan、selection和耗时字段。成功和decline都计算；预算不足报 `OUTPUT_BUDGET_TOO_SMALL`，不会裁剪来源、丢弃依据或返回事实前缀。环境连接或凭据不会写入回执或错误日志。

## 当前验证

原创合成单元和独立对抗fixture覆盖完整模板、regex字符字面性、连接词歧义、空白/Unicode/长度/词数边界、禁止字段sentinel与无状态词表行为。没有加载仓库gold、调用模型或改变审批。

```sh
node --test test/label-query-plan.test.js test/query-planner-adversarial.test.js test/search-query.test.js
node --test test/label-context.test.js test/label-context-cli.test.js
MIGRATION_TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test test/label-context-postgres.test.js
```

执行器测试使用原创合成fixture，真实HTTP测试证明登录、流式正文、注销及跨阶段共享期限会中断连接；真实PostgreSQL测试自行创建并删除随机临时库，覆盖RLS项目拒绝、值字段额外命中、来源修剪、25条范围拒绝、两遍之间批准新版本与窗口溢出，以及真实CLI读取。测试不调用模型、不读取答案标签；它们不是42题自然语言召回基准的重新运行，也不表示该缺口已普遍解决。

## 显式v2 metadata/exact协议

本节的纯协议校验、规划器、两个HTTP端点和显式CLI模式已实现。现有CLI默认仍为固定25条snapshot和all_terms，只有 `protocol:metadata_exact_v2` 才启用512标签和精确读取。HTTP/MCP/UI及其他客户端的默认搜索不变，不增加模型调用、schema迁移或依赖。

v2使用同一个认证会话依次执行登录、current-labels、计划成功时的context/exact、注销。成功为4次HTTP；范围不完整、未知标签或不支持的问题为3次，不执行exact，不分页，不回退v1。缺少新端点的旧服务返回的404仍是错误，不触发兼容回退。读取到complete:false直接needs_scope，返回的空labels不能被当作完整无匹配。认证会话相同不等于两个数据库读取共用事务；中途权限撤销会由exact的新授权检查拒绝，中途批准的新版本可在exact响应中出现。

结果schema是 `memz-label-context-v2`，包含显式protocol、plan.selector和同projectId的完整exact wire；保留原facts/provenance/sources及全文，不把它投影成旧substring快照。只有matched带context；授权/坏wire/超时/注销错误不输出部分上下文。stdin不能提供selector或词表，selector只能由本次完整授权metadata和固定模板产生。

`scripts/exact-context-protocol.js` 提供两个独立wire合同，分别用于 `GET /api/projects/:p/current-labels` 和保留CSRF的只读 `POST /api/projects/:p/context/exact`。服务器沿用cookie身份和实际memz_app的RLS，在只读REPEATABLE READ事务内先检查owner/member/viewer项目权限，再读取数据。纯函数本身不从JSON字符串证明授权或数据库完整性。

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

GET不接受任何query参数或请求体，不能用limit、after或q缩小探测再伪称完整。SQL只从facts投影键与内部排序ID，以version>0选择当前批准记录，最多探测513行；不连接或读取修订value、候选、来源正文。513行返回 `complete:false,labels:[]`。对完整范围中的非法过长键，安全字节守卫只返回无效标记并令整页失败；从不截断成另一合法键。传回的合法标签始终为原串。pending/rejected候选、零版本占位事实不加入词表。1MiB是序列化响应上限，超限失败，不裁剪；数据库内部扫描量不承诺最多513行，仍受原有数据库期限约束。

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

POST同样拒绝所有URL query参数，body必须通过原16KiB JSON对象限制与CSRF检查。selector在checkout前验证，数据库按参数化的project/subject/predicate唯一键精确相等查询；从facts出发LEFT JOIN当前修订，缺依据仍保留为待报错的记录，不因INNER JOIN漏行变成“未找到”。授权、事实、完整修订/候选/来源装配都在同一RR事务内；序列化后再次校验新的wire，保留全文，不截断依据。授权范围内确无当前记录时200空数组；无项目权限403，非法输入400、过大请求体413、完整性失败500。新只读POST的数据库503采用只读故障/超时提示，内部只读标记不能由请求头设置；原来源/候选写入的结果不确定提示不变。

metadata的complete只描述该次事务视图，不冻结之后的项目大小、权限或批准状态。随后单独发起的exact读取建立新事务，两次请求没有共同快照。

`scripts/label-query-plan-v2.js` 的 `planExactLabelQuery({question,labels})` 使用同一固定问句模板，独立限制最多512行。v2原始问句上限为210个UTF-16单位：两个100单位合法标签＋最长5单位连接词＋最长4单位问尾＋一个可选问号；先限长再trim，外围空白也占预算，因此最长带问号模板没有额外空白空间。合法代理对按两个单位计，不截断Unicode。唯一匹配返回 `mode:label_template_exact_v2`、`status:planned`、`selector` 与template，不生成all_terms查询，所以不施加旧八词限制。它不认识别名、代词、历史或多属性问题，仍保留明确拒绝；不接受gold、evidence、value或调用者提供的容量策略。调用者仍负责从单个已授权、完整current-labels响应提供词表，不拼分页快照。v1的 `planLabelQuery` 继续固定原始问句200单位、25行、八词与查询200单位限制；stdin16KiB、metadata512和正文/输出预算不变。本次是显式v2长标签覆盖增强，不改变默认协议。

```sh
node --test test/exact-context-protocol.test.js test/label-query-plan-v2.test.js \
  test/label-query-plan.test.js test/query-planner-adversarial.test.js \
  test/search-query.test.js test/context-snapshot.test.js
```

第一阶段的原创fixture覆盖512/513完整性、禁止证据字段sentinel、精确Unicode和标点、错误项目/selector、缺失或额外依据、新旧wire互相拒绝，以及原v1字段和失败状态兼容。第一阶段测试不涉及真实SQL或HTTP授权；这些行为由下述第二阶段单独验证，仍没有大项目查询性能结论。

第二阶段的真实本机HTTP/PostgreSQL验证使用独立随机数据库，schema owner直接装入原创合成批准fixture，结束后删除该库。它证明接口与数据库不变量，不代表人工审批质量、模型质量或生产服务：覆盖256/512/513、候选/占位排除、实际应用角色RLS、SQL仅取label、UTF-16正负边界、字面空白/SQL符号、只读POST鉴权/CSRF/503、并发批准时的RR旧视图及新事务新版本。坏数据用例仅在该随机库内暂时移除FK、制造悬空指针或篡改候选/来源后复原，断言500而非合法空结果；超1MiB来源不返回部分正文。没有模型调用、跨分页拼接或索引/性能收益结论。

第三阶段区分三类验证：mock transport用于穷举严格receipt、坏字段与整份UTF-8预算；独立本机HTTP服务故意不结束登录、metadata、exact、错误或注销正文，证明实际取消连接、主错误保留和跨读取总deadline；真实随机PostgreSQL库及真实应用HTTP验证256/512成功、513拒绝、v1仍needs_scope、跨scope、权限中途撤销、批准新版本、真实数据库锁等待时HTTP被取消，以及真实stdin子进程。客户端篡改真实服务返回selector的故障注入另行标识，不把它当成服务器曾主动返回坏wire。所有数据是原创合成fixture，没有模型调用或答案质量实验。

模块caller-signal回归另用真实loopback服务覆盖登录/读取headers和body、取消后继续注销、注销401未结束正文、注销期间的晚到取消、有限清理和label总budget。独立随机PG用例在观察到真实后端Lock等待后主动取消，证明HTTP实际关闭、会话已注销，并在释放本fixture锁后验证新的授权读取、RLS及连接池仍可用。它不承诺中止服务端已经开始的SQL，也不构成性能阈值或生产取消认证。

```sh
node --test test/exact-context-http.test.js test/request-body.test.js test/database-errors.test.js
node --test test/label-context-v2.test.js test/label-context-cli.test.js test/read-session.test.js
node --test test/read-cancellation.test.js
MIGRATION_TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test test/exact-context-postgres.test.js
MIGRATION_TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test test/read-cancellation-postgres.test.js
```
