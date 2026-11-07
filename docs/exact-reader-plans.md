# 精确读取的 SQL 计划检查

```sh
PLAN_DATABASE_URL=postgres://postgres:postgres_demo_only@127.0.0.1:5432/memz npm run eval:exact-plans
```

仅对已初始化的**测试 PostgreSQL 管理员连接**执行；不要使用生产连接。命令创建随机 `memz_exact_plans_*` 库，初始化当前 schema，结束时关闭应用池和 owner 连接、删除自己创建的库。不会更改指定数据库中的业务记录。连接、语句和驱动读取使用现有数据库期限，不接受 URL 同名参数取消期限；没有自动重试。

两个项目分别生成512、4096条明确标记的合成已审事实，附带来源、候选、修订和角色。直接构造已审状态只用于该原创 fixture，不是材料导入或自动审批功能。数据投影按稳定标签排序后计算 SHA256；报告保留实际 Node/PostgreSQL 版本、源码哈希、dirty 状态、索引和 planner 设置。

命令调用产品的 `readCurrentLabels`、`readExactContext`，截获实际执行的数据 SQL，再以同一个应用 viewer 角色、RLS 和只读事务运行两次 `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON)`。不复制一份简化 SQL 冒充真实路径，不禁用 seqscan 或强制索引。每个规模固定1条 metadata 查询、3条 exact 查询，合计16份计划；断言实际行数，验证完整溯源和来源，以及另一项目账号403、直接 SQL 零行。

metadata在512条时必须完整，4096条时必须返回 `complete:false` 与空标签；后者不会被称为客户端已支持4096标签。这里另以已知字面量键直接检查 exact SQL 的执行计划，模板客户端仍拒绝不完整词表。没有分页、共同冻结快照或自然语言质量结论。

结果在 `artifacts/exact-reader-plans.json`。计时是数据库执行计划仪器的样本，预先已经执行正确性查询并 ANALYZE，因此属于热状态；不是 HTTP 延迟、吞吐或冷缓存测试，也不是新旧技术栈对照。其他隔离测试可能同时运行，不能从两次计划计时推出生产 SLO、加速比例、token 或费用节省。来源表只有少量完整来源行，选择 seqscan 可以合理，不应仅因看到 seqscan就增加索引。
