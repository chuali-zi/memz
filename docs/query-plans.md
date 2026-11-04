# 来源分页与索引：可复现执行计划

## 要回答的问题

有LIMIT并不等于只扫描LIMIT条记录。现有sources主键(id)和唯一约束(project_id,id)都建立了B-tree索引；项目范围、游标、排序和标题子串条件如何共同影响计划，需要用真实应用角色观察。此实验补充数据库设计证据，没有增加索引或改变接口。

## 运行

在已初始化的测试PostgreSQL上执行：

```sh
PLAN_DATABASE_URL=postgres://postgres:postgres_demo_only@127.0.0.1:5432/memz npm run eval:plans
```

程序只创建和删除自己的随机memz_plans库，保留管理员连接指定的数据库。需要共享memz_app角色已由初始化创建。先提交代码，可得到workingTreeDirty=false的报告；失败返回非零并保存已有结果，不把不完整记录写成通过。

报告为artifacts/query-plans.json，CI单独上传query-plan-evidence。它是补充证据，目前不并入competition-evidence离线包的固定报告校验；引用时须同时给出该提交与CI终态。包内保留本说明和复现代码。不要将上一提交的计划混作新版结果。

## 固定数据与正确性

保留4条合成种子来源，分两阶段累计新增200、2000条来源。新增记录交替归属项目1和2，正文为100次“合成正文”，标题含固定补零编号。最终总量分别204、2004，项目1分别103、1003条。报告同时记录SQL实测分项目数量。

程序先执行真实readProject与readSourcesPage函数，从实际连接捕获来源SELECT及参数；没有另写一个看似相同但绕过RLS的查询。数据库计划使用非owner、非超级用户、无BYPASSRLS的memz_app，并在事务内设置用户1；记录实际角色属性、索引定义、PostgreSQL版本及相关规划设置。每次追加后ANALYZE sources与memberships，不强制指定索引或关闭顺序扫描。

每个规模验证：

- 兼容全量读取与确定的种子/插入结果逐行一致。
- 25条分页遍历覆盖全部项目1来源，无重复；页面游标与预期一致。
- 另一项目用户经应用函数得到403，直接执行同一来源SQL得到0行，分别验证应用权限与数据库RLS。
- 首页、80%位置后的深页、选择性标题和无匹配标题，结果与独立JavaScript筛选一致。
- 每个场景的EXPLAIN实际输出行数与正确性预期一致。

两种规模、每种5个计划场景，每场景保存2份EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON)，共20份原始计划。分页SQL多取1条判断下一页，因此报告的26行不是界面显示26条。

## 如何阅读与避免错误结论

legacy-all是现有兼容全量来源读取的工作量基线；page-first是单页读取，两者返回数据量不同，不能称为相同任务的优化前后对照。pagedEqualsFixture证明完整遍历的正确性，但完整遍历也不是单页的时间成本。

检查Node Type、Index Name、Index Cond、Filter、Rows Removed by Filter、Actual Rows/Loops、共享缓冲区命中/读取及Execution Time。不要简单累加父子节点缓冲区值，它们可能包含子树工作量；多个循环节点的行数还需要结合Actual Loops解释。

初次开发实验观察到：在2004条记录下，空标题首页采用主键Index Scan并输出26行；无匹配标题同样采用该索引，却过滤了2004行。小规模也可能选择位图扫描后排序。此例说明“使用索引”“返回有界”和“扫描有界”是三个不同判断。确切计划以该次原始报告为准，不将这一观察固定为CI必须选用的计划。

标题条件为position(lower(keyword) in lower(title))，普通项目/ID B-tree不直接提供任意子串定位。新增全文或三元组索引需要明确检索语义、扩展依赖、真实规模及维护成本的对照测试，本轮证据不足以推荐迁移。当前接口及数据保持兼容。

计划采集前已执行正确性查询和遍历，属于已触达数据场景；不清空OS或数据库缓存。两次带ANALYZE的采样只为保留观察，不提供可靠分位数、吞吐、冷缓存、并发负载或生产性能结论。计划内耗时不等于HTTP耗时，且受RLS函数、统计信息、版本、硬件与缓存影响。CI不设置毫秒阈值或固定节点类型，只断言数据正确性与权限边界。
