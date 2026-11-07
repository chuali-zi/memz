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

后续显式只读入口还需真实context snapshot获取词表、拒绝截断/多页范围、绑定项目和reader、总请求期限及完整回执校验。纯planner阶段尚未提供这个可执行CLI，不应把计划JSON当做已经取回的上下文。历史问题不会因当前词表规划而得到历史证据。

## 当前验证

原创合成单元和独立对抗fixture覆盖完整模板、regex字符字面性、连接词歧义、空白/Unicode/长度/词数边界、禁止字段sentinel与无状态词表行为。没有加载仓库gold、调用模型或改变审批。

```sh
node --test test/label-query-plan.test.js test/query-planner-adversarial.test.js test/search-query.test.js
```
