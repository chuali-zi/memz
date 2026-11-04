# 关键实现说明

本页解释已存在的实现，不是新增功能承诺。源文件是最终依据；函数名可直接检索定位，避免重排代码后固定行号失效。

## 1. JSON对象输入边界

位置：`server.js` 的解析器配置与 `requireJsonObject`。以下为当前代码：

```js
function requireJsonObject(req,res,next){
  const mediaType=req.get('content-type')?.split(';',1)[0].trim().toLowerCase();
  if(mediaType!=='application/json')return next(fail(415,'Content-Type 必须为 application/json'));
  if(!req.jsonBodyBytes||!req.body||typeof req.body!=='object'||Array.isArray(req.body))return next(fail(400,'请求体必须为 JSON 对象'));
  next();
}
```

该中间件只用于登录、新来源、新候选。解析器verify回调仅记录字节数，不保存原始请求内容，区分空请求与合法空对象。`{}`通过结构检查后仍需业务字段校验；登录缺凭据401，来源/候选缺字段400。审批、驳回和退出无需请求体。

解析器限制16KiB，按字节而非JavaScript字符串长度计量；测试包含刚好16KiB、超1字节、中文多字节以及gzip解压后超限。安全响应头中间件在解析器之前运行，解析失败也保留头部。已知解析错误映射成固定JSON消息，不把输入片段或解析器原始错误回传。JSON解析发生在身份检查前，解析错误可能先返回400/413/415；非JSON业务写请求仍先经过会话与CSRF校验。

## 2. 事务局部身份与连接归还

位置：`server.js` 的 `tx`。每次从池中取连接后BEGIN，使用参数化 `set_config('app.user_id',$1,true)` 设置身份；true表示仅当前事务有效。正常COMMIT，异常ROLLBACK，finally归还连接。读取模式采用 `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`，审批写事务使用默认隔离级别。

应用会话决定user ID，HTTP请求的X-User不参与身份选择。RLS函数读取事务身份以限制项目行。该方法信任应用服务；拥有应用数据库凭据的攻击者也能设置身份，不能把它当作抵御凭据泄漏的机制。测试覆盖无上下文不可见、连接复用不残留身份与聚合读取并发快照。

## 3. 审批并发与原子性

位置：`server.js` 的 `decide`。

1. 查询owner角色，`FOR UPDATE`锁定指定项目内候选；不存在404，非pending返回409。
2. approve路径按 `JSON.stringify([project,subject,predicate])` 的哈希取得事务级advisory lock，随后查询并锁定事实行。它覆盖尚无事实行的首次创建；仅锁已有事实行不能覆盖这个空缺。
3. 比较expected_version和当前version（新事实为0）。不一致抛409，外层事务回滚。
4. 插入新修订，更新当前指针/版本，改候选状态并插入审计，最后一起提交。

哈希碰撞只导致额外串行等待。版本约束与唯一键是第二层防线；数据库本身不自动把候选文本与修订文本比较，这由事务代码保持。测试显式在修订插入后注入异常，检查四类状态全回滚。ID序列可能留下间隙，不能用连续ID证明提交完整性。

## 4. 当前修订指针的复合约束

位置：`db/schema.sql` 与增量迁移。

```sql
ALTER TABLE facts ADD CONSTRAINT facts_current_revision_fk
  FOREIGN KEY(project_id,id,version,current_revision_id)
  REFERENCES revisions(project_id,fact_id,version,id);
ALTER TABLE facts ADD CONSTRAINT facts_current_revision_state
  CHECK ((version=0 AND current_revision_id IS NULL)
      OR (version>0 AND current_revision_id IS NOT NULL));
```

只检查project_id会允许同项目的错误事实关联；加入fact_id和version后数据库拒绝这类错误。CHECK防止正版本空指针绕过外键的NULL语义。version0仍可作为创建占位，首次创建不残留占位由应用事务保证。修订和审计对应用角色没有UPDATE/DELETE权限，但管理员不受此承诺约束。

迁移单事务锁定facts/revisions再安装并验证约束；锁等待5秒、单条语句60秒限制。旧数据不合法时失败并回滚，不擅自修复数据。测试比较全部业务行、序列、授权与RLS策略，并验证重复/并发执行。

## 5. 检索与前端呈现

位置：`readProject`、`public/app.js`。

检索仅连接facts.current_revision_id到对应修订，将主体、属性和值组合后用参数化position/lower做不区分大小写的子串匹配；`%`和`_`无LIKE通配意义。候选、历史和来源仍在各自数组返回，不被q过滤。界面通过textContent创建文本节点，外部文字不作为HTML插入或系统命令执行。

这不是语义搜索，也没有证明索引加速。评测报告计时覆盖完整HTTP聚合响应与JSON解析，不能当成单条SQL执行时间。当前接口返回未分页来源/候选/历史，数据量增长时响应规模是实际待评估问题。
