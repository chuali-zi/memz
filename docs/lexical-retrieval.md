# 可选的无序多词 AND 检索

当前事实包含主体“项目”、属性“截止日”时，旧查询 `q=截止日 项目` 因顺序和相邻关系不同而不匹配。新增显式 `match=all_terms`：把调用者提供的空白分隔片段分别匹配到当前事实的主体、属性或值，所有片段都命中才返回。片段可以跨不同字段、按任意顺序命中。

这是字面子串 AND 检索，不是自然语言理解、语义相似度、中文自动分词或相关性排名。结果仍按事实 ID 升序排列。没有新增数据库迁移、索引、依赖或外部服务，审批与 RLS 保持不变。

## HTTP 合同

```text
GET /api/projects/1/facts?q=截止日%20项目&match=all_terms&limit=25
```

仍使用已登录的会话。`match` 只接受 `substring` 或 `all_terms`；省略时为 `substring`。默认和显式 substring 继续使用原来的整段拼接字段子串查询，保持原来的响应结构、允许空查询、HTTP 查询超过200 UTF-16 code units的兼容截断规则，以及 Unicode/NUL 检查。历史、来源、候选及 `/data` 接口没有新增检索模式。

all_terms 的请求规则：

- `q` 必须是单个非空字符串，不能全为空白；原始长度最多200 UTF-16 code units，在 trim 之前检查，不静默截短。
- 必须为合法 Unicode，不接受未配对代理字符或 U+0000。一个 emoji 通常占两个 UTF-16 code units；这不是字符显示宽度或 token 数。
- 用 JavaScript `/\s+/u` 定义的空白拆分，包括普通空格、制表符、换行、不换行空格及全角空格；不执行语言分词。例如 `项目截止日` 是一个片段，不自动变成“项目”和“截止日”。
- 仅去除完全相同的重复片段，保留首次出现的顺序；去重后必须为1—8个。`API API` 计一个，`API api` 计两个；九个不同片段直接拒绝，不取前八个。
- 不做 JavaScript 小写转换、Unicode 规范化、词干化或同义词扩展。大小写匹配只由 PostgreSQL `lower()` 决定，受数据库 locale 影响；不能承诺所有语言都符合特定 Unicode case folding 规则。

未知模式、重复 `match` 或 `q` 参数、空查询、超过长度/词数及非法文本都返回400。未登录返回401，无项目权限返回403；有效查询无匹配时仍返回200和空事实数组。HTTP URL 编码/解码会在文本到达接口之前发生，接口只对实际解码得到的字符串校验。

每个片段必须在 `subject`、`predicate` 或当前修订的 `value` 中至少一个字段作为子串出现，全部片段都满足才命中。一个片段不能通过拼接两个字段来制造命中。使用参数化 `position()`，`%`、`_`、引号、反斜杠、`+`、`&` 等是普通文本，不是通配符、正则或 tsquery 操作符；URL 中保留字符仍须正确编码。没有引号短语语法，空白始终分词。

只在 all_terms 响应中新增 `search` 回执，例如：

```json
{
  "mode": "all_terms",
  "terms": ["截止日", "项目"],
  "order": "fact_id_asc",
  "matching": "all_terms_any_field_substring",
  "caseHandling": "postgresql_lower",
  "fields": ["subject", "predicate", "value"]
}
```

`terms` 是实际参与条件的片段，不是排名解释；没有分数或相关性次序。字段 `value` 指当前已批准修订的值。来源标题/原文、历史旧值、待审或驳回候选不参与匹配。来源依旧通过固定版本溯源读取。

## 上下文客户端

```js
const {readContext}=require('../scripts/context-client');
const context=await readContext({
  query:'截止日 项目',
  searchMode:'all_terms',
  provenanceMode:'batch',
  sourceMode:'deduplicated',
  maxOutputBytes:12000,
});
```

库和 stdin 选项 `searchMode` 只接受 `substring`（默认）或 `all_terms`。环境配置为 `MEMZ_SEARCH_MODE`，stdin 中显式选项覆盖环境值：

```sh
printf '%s' '{"projectId":1,"query":"截止日 项目","searchMode":"all_terms"}' | node scripts/context-client.js --stdin
MEMZ_SEARCH_MODE=all_terms MEMZ_QUERY='截止日 项目' npm run --silent demo:context
```

客户端在登录前检查模式、文本和词数，非法输入分别报 `INVALID_SEARCH_MODE`、`INVALID_QUERY` 或 `TOO_MANY_SEARCH_TERMS`，不发 HTTP 请求。默认客户端对 query 的原有200长度严格上限保持不变，不采用旧 HTTP 接口的截断行为。

all_terms 客户端发送 `match=all_terms`，要求服务返回与共享解析合同一致的全部 search 字段、片段及顺序。缺少回执、字段不符或额外未知回执字段均报 `INVALID_SEARCH_RESPONSE`，不返回部分上下文，并尝试注销。旧服务若忽略 match 参数，客户端会明确失败，不把它当成成功的多词查询。有效回执透传至结果顶层 `search`。

默认客户端不添加 match 参数，也不增加 search 字段；显式 substring 与默认输出相同。schemaVersion 仍由来源呈现方式决定：inline 为1，deduplicated 为2，搜索模式不会另行升级 schema。批量/逐条溯源与内联/去重来源四个组合均可使用；MCP 工具的既有参数合同没有变化，尚未暴露 searchMode。

## 预算、分页与一致性

`maxOutputBytes` 仍计算完整最终 JSON 的 UTF-8 字节，包括新增 search 回执、缩进、转义和最后换行。只保留事实 ID 升序的完整前缀，来源全文、修订和审批引用不丢失。回执额外占用字节，同一预算可能比默认模式容纳更少事实；字节不是 token，也不代表回答质量。

`limit`、`after`、`next_after`（HTTP）与 `nextAfter`（客户端）继续按事实 ID 工作，不按相关性分数分页。续读应保持项目、query、searchMode 和身份一致，并把前一次返回的 nextAfter 传入 after；每次返回自己的 search 回执和所需来源。改变查询或模式时应从头开始。

单张事实页使用现有只读 REPEATABLE READ 事务，读取已批准的当前修订。每条后续依据固定到该页返回的版本，因此读到 v1 后即使另一个会话批准 v2，仍返回 v1 的准确原文。完成时 v1 可能已经不是最新，既有 consistency 说明继续保留。

不同分页请求没有共享快照。跨页新批准的较大 ID 事实可能出现；较小 ID 的事实后来才满足条件，当前游标不会补回；事实值变化也可能使它在后页中消失。ID 顺序避免依赖易变评分的游标，但不承诺冻结结果集合或跨页完全一致性。

## 验证范围与限制

`test/search-query.test.js` 覆盖精确去重、Unicode/空白/200长度/8片段边界、默认兼容、旧服务缺回执、篡改回执和回执预算边界。真实数据库场景 `test/lexical-retrieval.js` 注册到 integration.test.js，也用于迁移后集成回归，覆盖中英文逆序跨字段、字面符号、当前版本过滤、三个项目角色与跨项目隔离、ID分页、四种来源/传输组合及精确预算续读、并发审批后的固定依据和翻页间新增事实。真实子进程场景验证 stdin/环境开关、覆盖优先级和无效输入在 HTTP 之前失败。

这些是确定性的合成功能断言，不是完整 benchmark、真实用户质量或模型测评。新模式最多对每行检查八个片段，可能增加数据库扫描工作；没有宣称索引收益或检索速度提升。[标题索引研究](search-index-study.md)记录的应用角色与 RLS 约束仍适用。本次改善是调用者可以表达明确的多片段字面条件，不涉及导入第三方代码或放宽权限。


## 本轮验证记录（2026-11-06）

本地在基于 `8baa0061f1550bea30763a184978106a304ea7f7` 的工作树上，使用 Node 24.19.0 和独立 PostgreSQL 16 测试容器运行：隔离核心系统测试86/86、迁移9/9、既有检索19/19及浏览器UI均通过；客户端相关20个单元测试通过。最后补强的“审批同时更换来源”和“已越过较小ID重新满足条件”断言，经再次迁移集成回归验证。默认功能的测试继续运行，没有用新模式替换旧模式的期望。

初次集成检查发现emoji用例的期望集合漏掉了同样含emoji的长度边界样例；修正为包含该样例的精确集合后重跑通过。未改变产品匹配规则来迎合测试。没有运行完整benchmark、调用模型、导入真实用户数据或新增性能结论。最终提交的干净CI另行核实，不能把本地dirty工作树报告当成该提交CI。

复现正确性检查使用README介绍的独立临时库流程；下面是公开合成测试连接示例，应指向已初始化的专用测试实例：

```sh
SYSTEM_TEST_DATABASE_URL=postgres://postgres:postgres_demo_only@127.0.0.1:5432/memz npm run test:system:evidence
node --test test/search-query.test.js test/context-client.test.js test/context-optimization.test.js
```

只有容器提供pg_dump/pg_restore时按README设置 `PG_TOOLS_CONTAINER`，并确保容器内可访问连接地址与端口。隔离测试自行清理它创建的随机数据库。本地原始系统报告保留在被忽略的 `artifacts/system/`；CI沿用system-test-evidence与competition-evidence归档。
