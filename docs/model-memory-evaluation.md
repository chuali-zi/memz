# 真实模型实验与只读工程入口

默认演示页面、MCP和context-client不调用模型。独立实验器通过 `DEEPSEEK_API_KEY` 调用官方DeepSeek；用户已授权本轮测试及推送。协议与初始研究依据见[预注册协议](../benchmarks/memory/DEEPSEEK_PROTOCOL.md)，原始结果和结论见[实验报告](../benchmarks/memory/DEEPSEEK_RESULTS.md)。

## 显式 reader 格式

`renderReaderContext(context)` 接受context-client的schema v1/v2，输出紧凑JSON字符串。`readReaderContext(options)`先调用原客户端再转换。它保留事实ID、修订ID、版本、完整subject/predicate/value、sourceId与去重后的来源标题/全文，以及projectId、不可信标记、一致性、truncated/nextAfter。

查询回执、候选ID和审批人字段不进入这个模型视图；完整审计继续从原客户端/接口读取。因此它不是原响应的无损序列化，也不替代授权校验。该函数检查结构与引用闭合，不提供来源真实性认证。完整依据不会被摘要或截断；共享来源ID冲突、来源缺失或多余、未批准版本元数据缺失均报错。数组顺序保持原事实顺序。

```sh
MEMZ_PROVENANCE_MODE=snapshot npm run --silent demo:context | node scripts/reader-context.js
```

CLI输入最多4MiB、30秒等待，接受一个JSON文档；输出是新的显式 `memz-reader-v1`。调用原客户端的maxOutputBytes限制原上下文，转换后应由宿主再做模型输入预算；精简格式不保证每个小输入都更小。

## 历史上下文

```sh
MEMZ_PROJECT_ID=1 npm run --silent demo:history
# 用上次nextBefore续读；不代表当前事实或整个项目的共同快照
MEMZ_PROJECT_ID=1 MEMZ_BEFORE=123 npm run --silent demo:history
```

`readHistoryContext(options)`默认viewer身份；支持baseURL、username/password、projectId、limit(1—25)、before(null或正整数)、请求/总超时、响应/输出字节上限。CLI沿用MEMZ_BASE_URL、MEMZ_USERNAME、MEMZ_PASSWORD、MEMZ_PROJECT_ID、MEMZ_LIMIT、MEMZ_MAX_OUTPUT_BYTES，另用MEMZ_BEFORE。

输出 `memz-history-reader-v1` 含输入before/limit、revisions、完整去重sources、不可信标记和nextBefore/truncated。先读一页history，再按factId+version批量取确切原文；含当前和被替代的**已批准**修订，排除待审/驳回。保留事实版本和修订ID顺序；没有返回业务生效时间，不支持任意日期的as-of查询。不同版本的同一factId可以同时出现。来源ID与原文不变，版本引用逐项验证。

普通非空页共4次HTTP请求：登录、history、batch provenance、注销；空页3次。分页与依据读取是不同事务，不承诺读完时最新；继续读取建立新视图。如果before不为null，调用者拿到的是旧页，不能用它判断当前状态。字节不足时明确失败，不删证据、不自动分页、不改用管理员身份；请求失败仍尝试注销。只读POST保留CSRF校验。

历史入口为显式API和CLI，尚未接入MCP的自动工具选择、自然语言搜索或自动路由。原整句substring检索仍有已记录的召回缺口。服务默认公开账号仅用于本机演示，不能当生产认证。

## 复现实验

需要Node.js 22+、Python3.10+和已初始化memz_app角色的**专用测试**PostgreSQL；下例管理员连接通过环境配置，不在仓库保存。export创建随机临时库，执行合成owner批准，启动本地HTTP，生成上下文后关闭并清理临时库，不修改传入数据库。

```sh
npm ci
mkdir -p artifacts/memory-quality
# MEMORY_EVALUATION_DATABASE_URL 已通过环境配置
npm run eval:memory:export
# 先检查请求上限和输入，不发送模型请求
python benchmarks/memory/scripts/deepseek_run.py \
  --input artifacts/memory-quality/export/inputs.jsonl \
  --output artifacts/memory-quality/check --split heldout --repeats 2
# DEEPSEEK_API_KEY 已通过环境配置；显式execute才发生付费请求
python benchmarks/memory/scripts/deepseek_run.py \
  --input artifacts/memory-quality/export/inputs.jsonl \
  --output artifacts/memory-quality/live --split heldout --repeats 2 --execute
python benchmarks/memory/scripts/deepseek_score.py \
  --export artifacts/memory-quality/export --run artifacts/memory-quality/live \
  --output artifacts/memory-quality/summary.json
```

输出路径必须不存在；重跑使用新路径。每次运行最多400请求、12MiB累计请求正文、单请求256输出token，超时45秒、并发2、无自动重试；鉴权、限额、网络或响应错误会停止后续批次，并为剩余题保留not_run记录（并发中的另一请求可能已发送）。模型输出截断算失败。完整分母保留失败/缺失记录，不通过删题提高分数。

冻结输入带SHA-256，配置记录源码提交及脚本哈希；gold与模型输入分离，只有离线评分器读gold。provider usage含输入、输出及缓存token，缺失记null；没有固定价格就不估算金额。模型计时含请求及worker启动，检索单独计时，不能声称在线端到端加速。参数与错误脱敏的离线回归可运行：

```sh
node --test test/reader-context.test.js test/history-context.test.js
python -m unittest discover -s benchmarks/memory/tests -p 'test_*.py' -v
```

论文与工程的对应：LongMemEval的更新/时间/拒答维度推动分开报告历史缺口；OpenViking的导航/原文分层启发显式模型视图，同时保留完整证据；MemGPT启发提供持久历史补读入口。没有运行OpenViking服务、embedding、reranker、自动抽取、公开基准全量或真实用户研究。
