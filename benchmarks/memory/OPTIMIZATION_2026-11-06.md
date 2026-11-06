# Memz 优化与验证记录（2026-11-06）

按最新要求“先优化、不着急实验”，本轮交付两项默认关闭、可分别启用的代码优化，并保留后续实验入口。没有调用 GLM 或其他模型，没有部署。完整模型 benchmark 延后；下列字节、HTTP 时间与证据召回均不是回答质量或计费 token 成绩。

## 已实施

- `provenanceMode: batch`：每批最多25个明确版本引用，项目权限、RLS 和读取在单个只读事务中检查；缺失任一版本整批失败。默认逐条读取仍可用。
- `sourceMode: deduplicated`：显式 schemaVersion 2，来源原文只输出一次，事实保留来源、修订、候选与审批引用。可无损恢复旧事实结构。
- 两者独立开关，旧 schemaVersion 1、关键词检索、审批、预算前缀和分页保持兼容。事实页与后续批次不是共同快照；各依据固定到页面所见的不可变修订。
- 预算仍先验证整页依据再裁剪，保持“被省略项失败也应失败”的旧合同。预算早停会改变错误语义，本轮没有实施。来源没有摘要、截断或自动清洗。

实现合同、API、CLI 及限制见 [context-optimization.md](../../docs/context-optimization.md)。设计依据见 [研究更新](RESEARCH_UPDATE_2026-11-06.md) 和 [6个仓库、9篇论文的版本/许可清单](research-sources-2026-11-06.json)。例如 [OpenViking 的预算实现](https://github.com/volcengine/OpenViking/blob/739e17f9172b9f595bfe4cc95293ec52d4686120/openviking/retrieve/context_assembler/budget.py) 启发减少重复表示，但其估算 token、摘要层级与跨轮 URI 冷却没有直接套用到 memz 的完整来源合同。

## 必要正确性检查

本地使用 Node 24.19.0、独立 PostgreSQL 16 容器和随机临时数据库；不改演示/业务库。所有临时数据库已由测试清理。

| 检查 | 结果 |
| --- | --- |
| 隔离核心系统/单元/HTTP/MCP/备份恢复 | 79/79 通过 |
| 新旧 schema、重复/并发迁移与集成 | 9/9 通过 |
| 既有合成数据库检索 | 19/19 通过 |
| 查询计划和关键词搜索比较 | 通过，10个基线用例 |
| 浏览器 UI 证据 | 通过 |
| 数据库断连与恢复 | 通过 |
| 离线准备、检索、导出、GLM mock 测试 | 46/46 通过，无网络模型调用 |
| JS/Python 语法、diff 空白检查 | 通过 |

新增真实数据库回归覆盖跨项目混合批次、角色/CSRF、25/26批次边界、缺失版本、同一事实不同旧版顺序、审批竞态、输出逐字段等价、预算恰好/少一字节、续读自带来源及被省略批次失败。

这些本地检查在基于 `148622bc84a82289beaab80f95da455fb44822d2` 的工作树运行；原始报告记录源码哈希与 dirty 状态，未将它们冒充最终提交的干净 CI。最终远端提交和 CI 状态以交付消息中的精确链接为准。CI 新增 `eval:context` 并归档 `context-optimization`，保留全部旧检查。

## 已完成的轻量同事实消融

`evaluation/context-optimization.js` 在随机临时库构造25条共享来源、25条独立来源及批准/过时/驳回/待审冲突样例，四组固定顺序轮换。每组2次预热、20次计量，并发1。最终计量时本任务其他数据库测试已经结束。计时包括登录、事实页、依据、客户端装配与注销；所有组使用相同响应克隆计量，包含这部分开销。它测本机读取链路，未测网络 RTT、负载吞吐、模型 prefill 或回答。

| 共享来源25事实，无预算 | HTTP 请求 | 最终上下文字节 | p50 / p95 ms |
| --- | ---: | ---: | ---: |
| individual + inline | 28 | 238,558 | 91.85 / 114.24 |
| batch + inline | 4 | 238,558 | 15.78 / 19.75 |
| individual + deduplicated | 28 | 16,098 | 85.95 / 96.81 |
| batch + deduplicated | 4 | 16,098 | 15.59 / 19.19 |

无预算时四组都保留同样25条事实和确切来源。16,000字节预算下 inline 返回1条，deduplicated 返回24条；续读可重建相同全集。当前批准截止日15号保持不变，20号旧版、30号驳回、40号待审不覆盖当前值，基于旧版的25号更新被拒绝；这只是确定性合成状态验证，不是模型抗旧事实干扰测评。

反例同样保留：25条事实来源各不相同时，去重字典使输出从124,319增至124,384字节。batch 仍逐项返回完整来源，HTTP 总响应正文在共享场景从241,603增至241,689字节；它减少往返，并没有减少网络正文。不能把此表读成任意场景的端到端加速或 token 节省。

记录了28次来源写入（共44.14ms，中位1.18ms）、51次候选＋审批事务（共221.09ms，中位3.85ms）以及4次更新/驳回/待审/冲突维护（共8.46ms）。没有新增索引；数据库页分配计量前后均8,485,911字节，不代表写入没有存储成本。本次写入数字是该合成流程的观察，没有声称相对旧实现的写入改善。

机器可读汇总、源码和原始报告哈希见 [optimization-2026-11-06.json](results/optimization-2026-11-06.json)。逐次本地原始报告是被忽略的 `artifacts/context-optimization-final.json`。较早与其他测试并发的 pilot 未用作上表计时。

## 已有离线检索结果与保留入口

最新优先级调整前启动的纯离线检索校验已完成，未继续扩大实验。LoCoMo 从既有 manifest 锁定的官方 GitHub 地址取得，2,805,274字节，SHA256 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`；10对话、5,882 turn、1,986题。Library 交接包官方下载 helper 返回失败，未重试；本次没有取得或重新分发该交接包，也未绕过网络限制。

新增独立 runner/scorer，分别只读取 corpus/query 与 evaluator gold。四臂为 no_memory、raw_full、raw_budget_recency、自写 BM25；raw_full 明标未匹配预算，不能作为公平质量优势。2048/8192/32768 UTF-8字节三点每点7,944条记录，均0错误。固定 seed 42，按对话 scope 划2个 dev（481题）和8个 test（1,505题），无参数调优；全部结果为探索性。完整来源数据、规范化数据、逐题 trace、gold 和模型输入均不提交。

| test scope 的字节预算 | recency evidence recall | BM25 evidence recall |
| --- | ---: | ---: |
| 2,048 | 0.0088 | 0.5227 |
| 8,192 | 0.0743 | 0.6697 |
| 32,768 | 0.2890 | 0.7923 |

指标按每题已发布 evidence 引用计算，再取题均值；test有1,501题可计分、4题无evidence记N/A。全数据9题包含无法直接解析的引用，严格口径把无法解析引用算未命中，另给resolved-only辅助分母，不改标签。8192字节的BM25-minus-recency配对召回差为0.5954，8个scope的2000次bootstrap描述性95%区间为[0.5767, 0.6205]；scope数很少，不是质量非劣性证据。BM25全量索引构建观察63.03ms，序列化postings大小代理1,334,371字节；不是实际数据库索引大小或RSS。

上述 BM25 是独立离线基线，不是 memz 产品搜索，也没有跑 OpenViking 或生成答案。检索命中不能代替最新状态回答、来源忠实性或拒答能力。完整模型输入/输出token、费用、生成延迟及回答质量全部为 null。详细协议见 [OFFLINE_RETRIEVAL.md](OFFLINE_RETRIEVAL.md)。

## 复现入口

正常应用启动后可试两个显式开关：

```sh
MEMZ_PROVENANCE_MODE=batch MEMZ_SOURCE_MODE=deduplicated MEMZ_QUERY=项目 npm run --silent demo:context
```

准备好已初始化的专用测试 PostgreSQL 管理连接后，使用项目的隔离测试与消融入口；下面连接仅是公开合成演示凭据：

```sh
SYSTEM_TEST_DATABASE_URL=postgres://postgres:postgres_demo_only@127.0.0.1:5432/memz npm run test:system:evidence
CONTEXT_EVALUATION_DATABASE_URL=postgres://postgres:postgres_demo_only@127.0.0.1:5432/memz npm run eval:context
python3 -m unittest discover -s benchmarks/memory/tests -p 'test_*.py' -v
```

消融默认新建 `artifacts/context-optimization.json`，已有报告时需用 `CONTEXT_EVALUATION_OUTPUT` 指定新路径。本地仅容器提供 pg_dump/pg_restore 时，按 README 配置 `PG_TOOLS_CONTAINER`，容器内也须能访问连接中的地址/端口。

后续离线全量命令（本轮已完成，现不要求追加重跑）：

```sh
python3 benchmarks/memory/scripts/retrieval_run.py \
  --corpora benchmarks/memory/prepared/locomo/corpora.jsonl \
  --queries benchmarks/memory/prepared/locomo/queries.jsonl \
  --budget-bytes 8192 --seed 42 --dev-scopes 2 --split all \
  --output benchmarks/memory/reports/new-run
python3 benchmarks/memory/scripts/retrieval_score.py \
  --run benchmarks/memory/reports/new-run \
  --corpora benchmarks/memory/prepared/locomo/corpora.jsonl \
  --queries benchmarks/memory/prepared/locomo/queries.jsonl \
  --gold benchmarks/memory/prepared/locomo/gold.private.jsonl \
  --bootstrap-samples 2000 --output benchmarks/memory/reports/new-score
```

## 未运行与下一步

GLM适配器、严格无gold的context导出和22项mock测试已准备，但没有任何实调用；按最新要求不等待密钥。当前云环境 `MEMZ_GLM_API_KEY`、`ZHIPUAI_API_KEY` 均未配置，智谱官方主机不在当前网络允许清单；没有修改网络或权限。LongMemEval S/oracle/M、MAB parquet/entity2id、V2数据仍缺，未重试先前HF拒绝的下载。OpenViking的session memory和resource RAG通路明确分开，均未运行。

恢复模型实验时，优先固定同一已批准事实包、模型快照/完整prompt/tokenizer和预算，比较inline与deduplicated的回答忠实性、旧值错误和拒答，再测完整读取＋生成延迟与计费usage；来源共享和完全独立两种负载都应保留。原始历史→抽取→人工审批→回答的完整系统路径仍未实现，不能把本轮同事实工程优化冒充那条路径的收益。LoCoMo仍受CC BY-NC 4.0约束，OpenViking源码没有合入本仓库。
