# 可选的批量溯源与来源去重

这两个独立选项分别减少 HTTP 往返和重复来源输出，均默认关闭。不改变当前事实检索、审批、RLS 或历史版本；没有引入模型调用、摘要、语义排序或第三方实现。

```js
const {readContext}=require('../scripts/context-client');
const context=await readContext({
  query:'项目',
  provenanceMode:'batch',
  sourceMode:'deduplicated',
  maxOutputBytes:12000,
});
```

本页描述 `provenanceMode` 的 `individual`（默认）与 `batch`；新增的显式 `snapshot` 模式及其25条上限见[单页快照上下文](snapshot-context.md)。`sourceMode` 只接受 `inline`（默认）或 `deduplicated`。非法值在登录前失败，错误码分别为 `INVALID_PROVENANCE_MODE`、`INVALID_SOURCE_MODE`。环境变量为 `MEMZ_PROVENANCE_MODE` 与 `MEMZ_SOURCE_MODE`；stdin 显式配置覆盖环境配置，仍不允许传凭据或服务地址。

```sh
printf '%s' '{"projectId":1,"query":"项目","provenanceMode":"batch","sourceMode":"deduplicated","maxOutputBytes":12000}' | node scripts/context-client.js --stdin
MEMZ_PROVENANCE_MODE=batch MEMZ_SOURCE_MODE=deduplicated MEMZ_QUERY=项目 npm run --silent demo:context
```

未配置新选项时，既有 `schemaVersion:1`、内联 `facts[].source` 和逐条固定版本 GET 保持原状。`batch` 配合 `inline` 时输出结构与逐条模式相同。依赖 schemaVersion 1 的消费者应继续使用 inline；只有显式选择 deduplicated 才收到 schemaVersion 2。目前 MCP 工具没有暴露新选项，继续使用既有默认合同。

## 批量读取合同

新增只读接口 `POST /api/projects/:p/facts/provenance`，使用已有 session cookie、JSON Content-Type 和 CSRF 校验。请求体必须为：

```json
{"facts":[{"id":12,"version":3},{"id":7,"version":1}]}
```

示例 ID 必须换成真实事实页中的值。`facts` 数组长度为 1—25；每项恰好包含整数 `id`、`version`，范围均为 1—2147483647，不接受数字字符串、缺失版本、额外字段或重复 `(id,version)`。同一事实的不同历史版本允许并存。无效输入 400；非 JSON 请求 415；未登录 401；CSRF 或项目权限不符 403。

返回 `{sourceTextIsUntrusted:true,role,provenance:[...]}`。`provenance` 严格按请求顺序排列，每项与既有单条 provenance 响应相同，包含原文、修订、候选、提议者和批准者。任意一项属于其他项目、事实不存在或版本不存在时，整批 404，响应只有错误、不返回部分依据。身份、项目权限及全部版本读取在同一个 REPEATABLE READ READ ONLY 事务中执行，版本通过一次查询匹配；继续使用应用角色与既有 RLS。

客户端先验证整张事实页，再按最多25条一批提交页中固定的版本。收到的条数、顺序、事实键/值、修订版本、来源和审批引用必须与合同一致；不一致使整次失败，并尝试注销。空事实页不提交空批次。批次限制使最大合法字段在默认 1 MiB HTTP 响应上限内；调用者若把 `maxResponseBytes` 调小，合法批次仍可能因 `RESPONSE_TOO_LARGE` 失败，不自动切换到其他读取方式。

对于实际返回 N 条事实，逐条模式的 HTTP 请求数为 `N+3`，批量模式为 `ceil(N/25)+3`，包括登录、事实页和注销；N=0 时均为3。批量响应仍重复携带共享来源原文，且增加包装字段，响应 JSON 总字节可能略增；它减少往返，不是网络正文压缩。请求计数描述正常完成的单次读取，不是时延或吞吐承诺。没有自动回退、重试或并行请求。

事实页和之后的批次不是同一个事务；每批事务也相互独立。若读到 v1 后批准 v2，仍读取 v1 的不可变依据，不能把它宣称为完成时最新。既有 `consistency` 说明保持不变。

## 来源去重合同与预算

schemaVersion 2 的每个事实保留 `id`、`subject`、`predicate`、`value`、`version`、`revisionId`、`candidateId`、`proposedBy`、`approvedBy`；用 `sourceId` 替换内联 `source`，顶层新增 `sources:[{id,title,content}]`。来源按事实首次引用的顺序出现，以来源 ID 去重，不能按标题或相同正文合并不同来源。`sourceTextIsUntrusted:true` 与完整 `consistency` 仍在顶层；原文仍是不可信数据。

每个事实都可通过 `sources.find(source=>source.id===fact.sourceId)` 重建内联来源。相同来源 ID 返回不同标题或正文时，客户端报 `SOURCE_MISMATCH`，不静默选取一个版本。空结果包含 `facts:[]`、`sources:[]`。不对原文摘要、截断、改写或自动执行。

可选 `maxOutputBytes` 仍以两空格缩进 JSON 加最后换行的 UTF-8 字节计量，包括事实、其所需的完整来源及所有元数据。去重发生于最终输出，HTTP 批次中的原文仍随每项依据返回。预算保留按事实 ID 升序排列的完整前缀，只包含该前缀实际引用的来源；共享来源只计一次，新来源必须完整容纳，不会跳过较大的事实去塞后续较短的事实。若第一条事实连同来源和元数据放不下，仍报 `OUTPUT_BUDGET_TOO_SMALL`。

所有事实的依据在裁剪预算之前读取并验证；被省略事实的失败也会使整次失败。`outputBudget.omittedFacts` 仅统计此次事实页被省略的数量。`nextAfter` 仍指向最后返回的事实，继续调用时传入 `after`；每份续读输出自带它需要的完整来源，不依赖上一份来源表。跨页继续是新快照，既有并发和游标限制见 [context-client.md](context-client.md)。

## 验证与消融接口

固定同一合成数据库、查询、条数、预算和身份，分别运行下表六组。`readContext` 已有 `fetchImpl(url,options)` 注入点，可用包装的原生 fetch 统计请求数及响应体字节；计时应涵盖完整 readContext 调用。输出字节应使用 `Buffer.byteLength(JSON.stringify(context,null,2)+'\n')`，不能当作模型 token 数。

| provenanceMode | sourceMode | 比较目的 |
| --- | --- | --- |
| individual | inline | 默认基线 |
| batch | inline | 单独衡量批量传输 |
| individual | deduplicated | 单独衡量来源输出去重 |
| batch | deduplicated | 两项组合 |
| snapshot | inline | 单请求快照与传输去重，最终仍内联 |
| snapshot | deduplicated | 单请求快照及最终来源字典 |

预算相同时，两种 schema 可能容纳不同数量的完整事实；既要记录字节数，也要记录实际返回事实数和来源数。无预算时，把去重结果重建为内联事实后逐字段比对；不能只比较条数。来源共享率、原文长度、事实数、网络往返和数据库状态都会影响结果。单来源短文本可能因 schema 元数据出现更大输出，不承诺所有输入都节省字节。

`test/context-optimization.test.js` 是无数据库客户端回归：两开关、25条分批、输出等价、篡改响应、相同来源 ID 内容冲突、完整来源前缀预算的恰好边界/少1字节及续读。`test/context-optimization.js` 由 integration.test.js 注册，并随旧库迁移的集成场景执行，使用真实 PostgreSQL 验证 27 条事实、25/26数量边界、输入类型、鉴权、跨项目混合批次、整批失败、历史版本顺序、审批并发、全部依据先验证和去重续读。`test/context-process.test.js` 覆盖真实进程的 stdin/环境选择和覆盖优先级。测试均使用公开演示账号和合成数据，不是模型回答质量评测。
