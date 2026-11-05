# 来源核实与适配判断

核查时间 2026-11-05。下面区分上游公开陈述、源码可观察行为与本项目待验证假设。所有代码版本、源码引用与原调研范围见 `sources.lock.json`（仅引用，不分发源码）；数据见 `manifest.lock.json`。网页用于来源核实，云容器下载遵守其独立网络政策。

## OpenViking 可以借鉴什么

固定版本：[739e17f](https://github.com/volcengine/OpenViking/tree/739e17f9172b9f595bfe4cc95293ec52d4686120)，原调研时使用固定版本 checkout；仓库内不分发该源码。核心许可是仓库 LICENSE 中的 AGPL-3.0，其他目录可能有自己的许可证；本轮只研究、下载和独立编写适配脚本，没有把其实现合入 memz。

1. **统一可检查的上下文命名空间**：`viking://` 组织 resources、user/Peer memories 和 skills，用目录/文件操作查阅来源。L0 abstract、L1 overview 和 L2 原文让调用者按需要选内容。分层结构本身不保证更少 token，摘要生成、重建和重复读取也要计费。[固定 README](https://github.com/volcengine/OpenViking/blob/739e17f9172b9f595bfe4cc95293ec52d4686120/README.md)，[context layers](https://github.com/volcengine/OpenViking/blob/739e17f9172b9f595bfe4cc95293ec52d4686120/docs/en/concepts/03-context-layers.md)。
2. **会话记忆与原文 RAG 是两条实验路径**：session `add_message` 后 `commit` 归档并异步做摘要/记忆抽取，可能新建、合并、更新或删除记忆；要等 task 完成，检查 memory_diff。`add_resource` 则解析原始材料、存储并语义处理，不能把 raw conversations 作为资源后的成绩叫 persistent-memory 抽取成绩。[session](https://github.com/volcengine/OpenViking/blob/739e17f9172b9f595bfe4cc95293ec52d4686120/docs/en/concepts/08-session.md)，[评测总指南](https://github.com/volcengine/OpenViking/blob/739e17f9172b9f595bfe4cc95293ec52d4686120/benchmark/README.md)。
3. **精确区分此版本的检索与旧介绍**：本次源码中的 `HierarchicalRetriever` 运行 global vector search，可按 URI/权限/type/level 过滤，随后可选 rerank。`find` 是无 session intent 的单查询 QUICK 路径；`search` 可在有 session 内容时使用 LLM 规划多个查询。当前文档明确移除了递归队列、父子分数传播和收敛轮次。不要因类名或旧文章称为“当前递归目录搜索”。模型规划与 rerank 的额外成本也应单列。[源码](https://github.com/volcengine/OpenViking/blob/739e17f9172b9f595bfe4cc95293ec52d4686120/openviking/retrieve/hierarchical_retriever.py)，[当前检索文档](https://github.com/volcengine/OpenViking/blob/739e17f9172b9f595bfe4cc95293ec52d4686120/docs/en/concepts/07-retrieval.md)。
4. **对 memz 的启发是可追踪的读写与分阶段计量**，不是直接替换。memz 强调批准版本、来源、修订和审计；OpenViking 的模型抽取更新与 memz 的 owner 审批语义不同。未来若研究摘要/检索预算，必须保留确切版本与原始证据，并把人工审批和抽取成本暴露出来。

## OpenViking 的公开评测路径与声明边界

`benchmark/README.md` 是当前入口，原调研已检查以下实现（此处仅提供引用）：

| 场景 | 代码 | 数据与指标 | 不能混淆的内容 |
| --- | --- | --- | --- |
| 例行 VikingBot persistent memory | `benchmark/locomo/vikingbot/{import_to_ov.py,run_eval.py,judge.py,stat_judge_result.py}` | LoCoMo；该 Agent 的二元 judge/统计及 CSV | 不是把数据当 resource；不自动等同历史公开报告 |
| OpenClaw/Hermes/Claude Code 集成 | `benchmark/locomo/openclaw`、`hermes`、`claudecode` | LoCoMo；各自工具轨迹、延迟和 token、各自 judge | native/e2e/preingest、SDK 隔离方式、QA/judge prompt 均需单独锁定 |
| 单次检索记忆 QA | `benchmark/locomo/openviking`、`benchmark/longmemeval/openviking` | 单次搜索、可选 rerank、回答和 judge | 默认 mem0 风格宽松 judge；不能和 VikingBot/官方 F1 混分 |
| 文档 RAG | `benchmark/RAG` | Qasper、FinanceBench、SyllabusQA，以及 raw LoCoMo 配置；F1、evidence recall、judge、tokens/latency | Qasper 0–4 judge 非二元 accuracy；此 recall 非普通 document Recall@k |
| agent experience | `benchmark/tau2` | 外部 tau2-bench，retail/airline task success/reward | 需要受控轨迹学习、环境重置、测试隔离，后续阶段才考虑 |

官方 README 指向 [2026-05-29 benchmark report](https://blog.openviking.ai/post/openviking-benchmark-results/)，声称 OpenViking 0.3.22 在 LoCoMo 的三个 Agent 集成上提升 accuracy，并减少输入 token 和 query latency；还报告 tau2 task success 改善。本轮报告网页未能通过浏览工具打开，故数值核实限于固定仓库 README 和 benchmark 总指南。

这些是**上游陈述**：OpenClaw 24.20%→82.08%、Hermes 33.38%→82.86%、Claude Code 57.21%→80.32%；输入 token 减少范围 34.3–91.0%，query latency 减少范围 58.45–66.10%。本轮没有运行这些系统或验证其测量账本，不能推断 memz 有同样效果。当前脚本默认值和最新 commit 不是历史 0.3.22 实验的完整锁定配置；总指南也说明没有固定每个运行参数。

尤其要检查：`run_eval.py` 的 token usage fallback 在缺失 provider usage 时会返回 0。后续测量器必须把“不可观测”记为 null/unknown，不能把它作为免费调用。导入的 LLM、embedding、摘要、维护和重试成本也不包含在单次 answer prompt token 内。

OpenViking 的 RAG 默认 `all` 与 `del` 会递归删除可访问的资源根；本任务没有执行任何上游 runner。后续只用全新隔离实例，并显式选择 `gen`/`eval` 等已检查流程；不能指向已有用户数据或共享实例。

## benchmark 优先级、来源、许可与难点

### P1：LongMemEval-cleaned S + oracle

[官方代码](https://github.com/xiaowu0162/LongMemEval/tree/9e0b455f4ef0e2ab8f2e582289761153549043fc)，[官方 cleaned 数据](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)，[文件发布 commit](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/commit/98d7416c24c778c2fee6e6f3006e7a073259d48f)。代码 MIT，数据卡 MIT；公开无登录门槛，但本容器域策略阻断。

每个文件 500 个问题，测信息抽取、多会话/时间推理、知识更新与拒答；S 约 115K Llama-3 tokens/history 是作者描述，不是此处的模型精确计数。M 更长。S/oracle/M 分别为 277,383,467 / 15,388,478 / 2,737,100,077 字节，预期 SHA256 已由发布指针核实，**实际文件在此均缺失**。

选择理由：知识更新、时间与拒答贴近 memz 的版本性任务。限制：自然语言记忆与已批准项目事实不是同一输入。oracle 只含证据会话，属于有答案位置先验的参考上界；不得用它预填 memz 再与 S 全历史基线比较。每题独立历史只被问一次时，不能用全部 500 题摊销每份历史的一次性写入。

官方端到端正确性是 `src/evaluation/evaluate_qa.py` 的 LLM judge；类别与 abstention 另报。检索有 session/turn recall 指标，官方检索统计排除 30 道 abstention（QA 不能排除它们）。`has_answer`、`answer_session_ids` 和答案只能留给 evaluator。官方 README 的旧示例文件名省略 `_cleaned`，本任务命令使用实际文件名。标准库 JSON loader 避免 HF viewer 中混合 answer 类型的 Arrow 推断问题；不把数值答案擅自转成标签字符串。

### P1：LoCoMo 原始 QA（已可用）

[官方代码/数据](https://github.com/snap-research/locomo/tree/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376)，[论文项目页](https://snap-research.github.io/locomo/)。仓库 `LICENSE.txt` 为 **CC BY-NC 4.0**，应保留署名和非商业限制；本轮研究使用，未发布。不要误标 MIT，不把未来商业用途默认视为已获授权。

这里是当前 10 对话版本，不是早期 50 对话版本。图片没有作为文件随数据发布；脚本仅使用现成 `blip_caption` 文本，不访问图片 URL。输入不含已发布的 observation/session_summary/event_summary，这些派生产物可能由其他模型生成，有额外先验或成本。

官方 `task_eval/evaluation.py:eval_question_answering` 是分类处理：category 1 使用分答案 F1；2/3/4 用词级 F1，3 对答案分号处理；5 用特定拒答短语判定。应固定该原实现；不能把自写 EM 或 OpenViking 的 LLM judge 称为同一官方分数。OpenViking 的 LoCoMo judge/stat 跳过 category 5，故其主报告分母应单独标明 1,540；我们的完整离线通路保留全部 1,986 题。

本地完整性核查另外发现 9 个 evidence 引用不与原始 turn ID 直接匹配，例如一个字段里含多个以分号分开的 ID、残缺 `D` 或实际不存在的 ID，逐项见本地生成的 `reports/offline-validation.json`（运行脚本生成，不提交标签）。本任务保留原标签，没有自动修复或删除题目；将来计算 evidence recall 应冻结解析规则并报告不可解析分母。

### P1/P2：MemoryAgentBench（优先 AR + CR）

[官方代码](https://github.com/HUST-AI-HYZ/MemoryAgentBench/tree/538026089d1a8a8eff05121d0db89b388f360eba)，[官方数据](https://huggingface.co/datasets/ai-hyz/MemoryAgentBench/tree/7ea066982b140a19337e17e60d45d4076e042faf)，[论文](https://arxiv.org/abs/2507.05257)。代码及数据卡 MIT；由其他数据转化而来，保留各上游数据条件，不能把聚合 MIT 元数据视为替代源数据许可。

四个 parquet 实际预期共 74,805,902 字节；每个的 LFS SHA256/字节数已核对，见 manifest。entity2id 约 1.76 MB 为 recommendation 所需，精确 hash/字节数尚未核实；acquire 不会自动下载没有预期 hash 的文件。原云端准备环境四个 parquet 均未落盘；不能由其他环境的下载推断本 checkout 已具备数据。

四类能力：Accurate Retrieval、Test-Time Learning、Long-Range Understanding、Conflict Resolution。一次写入多个查询适合显式计算记忆的摊销成本。AR 的 EventQA/RULER 以及 CR 的 FactConsolidation 最贴近检索/更新；TTL 和长篇总结对当前 memz 的适用性较弱，分阶段追加。

官方度量按子数据集保留：event_qa/ruler_qa1/ruler_qa2 与 fact_mh/fact_sh 用 `substring_exact_match`；detectiveQA 与 ICL 分类用 `exact_match`；recsys 用 Recall@5；LongMemEval 用官方 LLM judge；InfBench summary 用 HELMET 风格 LLM judge F1。不得统一换成一个 EM，再比较论文结果。

适配难点：官方按 `metadata.source` 过滤，`qa_pair_ids` 在 metadata；原 loader 硬编码 revision="main"，直接运行会漂移/访问网络。这里的 loader 直接读固定 parquet，但没有冒充官方任务执行器：sentence/token chunking、query/response 模板、context_max_length、demo/recommendation、previous_events 等需按 source 与固定官方配置实现。官方 README 的 `bash_files/eniac/...` 路径在该 commit 不存在，实际为 `bash_files/sh/...`，且脚本带机器特有 conda/GPU 假设；不应盲跑。

CR 的“最新陈述生效”与 memz 的“最新批准版本生效”不同：pending/rejected 并非来自 benchmark 的语义标签。若要研究审批价值，应增加独立带审批事件的合成任务，不能偷偷把 CR 改成 memz 的审批规则后仍叫官方 CR。

### P2：LongMemEval-V2（准备代码，数据延后）

[官方代码](https://github.com/xiaowu0162/LongMemEval-V2/tree/2cc8c540bdb87fe6761629b585e727e1c4704520)，[官方数据](https://huggingface.co/datasets/xiaowu0162/longmemeval-v2/tree/f152293e235517d504809563c833d7190b8c713b)，代码/数据卡 Apache-2.0。官方描述 451 题、web/enterprise 域，静态状态、动态状态、workflow、gotchas、premise awareness；最大历史多模态轨迹非常大。原调研检查了完整代码，数据完全未下载；7.12 GB 级计划容量不包含未经核实的解压开销。

`Memory.insert(trajectory)` / `query(query, query_image=None)` 的 evidence-return 合同很适合未来作为统一后端接口；固定 reader 消费 text/image items 并执行 `memory-context-max-tokens`。query 不接收题目 gold 或类型，仅有 run-local invocation ID。[后端合同](https://github.com/xiaowu0162/LongMemEval-V2/blob/2cc8c540bdb87fe6761629b585e727e1c4704520/memory_modules/memory.py)。

官方 LAFS 使用 `overall_full_set` 与 `memory_query_avg_seconds` 的 accuracy-latency frontier；该 latency 只围绕 memory.query，未覆盖写入、reader 或 judge，不能直接当端到端成本。论文固定 reader/embedding 配置与本项目未来选定模型要分开标注。当前 memz 仅文本，不能静默忽略 screenshot 问题再说是全量 V2。

### P3：agentic 任务

tau2-bench 可从 OpenViking 官方 `benchmark/tau2` runner 研究；MemoryArena 是 [MemoryAgentBench 官方 README](https://github.com/HUST-AI-HYZ/MemoryAgentBench/blob/538026089d1a8a8eff05121d0db89b388f360eba/README.md) 指向的后续 agentic 评估。它们只列后续候选，本轮未核实完整独立数据/许可证/精确版本，未下载、未给出性能数值；不抢占主线数据验证。

## 与当前 memz 的能力差距（源码核实）

依据 memz 基线提交的 [README](../../README.md)、[context-client 文档](../../docs/context-client.md)、[server.js](../../server.js)、[客户端](../../scripts/context-client.js)：

- 无真实模型、无自动摘要/语义抽取/压缩/语义排序；HTTP 检索是对 subject + predicate + 当前 value 的大小写不敏感**整段子串匹配**，不检索历史或 source 正文。
- source title 150/content 4,000、subject/predicate 100、value 1,000 均按 UTF-16 code units 限制；JSON body 16 KiB。不能把一份 100K-token history 塞进单个事实或来源。
- 新来源与 candidate 并不自动进入当前事实；需要 owner 审批。以 benchmark gold 生成或批准事实是标签泄漏。
- context-client 每次登录/读取一页/逐事实 provenance/注销，limit 最大 100；重复 source 可能重复输出。N+1 请求、认证、字节截断、cursor 继续读取和失败均应计入成本。`maxOutputBytes` 不是 token budget；来源全文可能使所谓“记忆上下文”比原文还大。
- 同步稳定视图需隔离数据、停止写入，并记录每个 fact/version/revision/source；跨页不是全程共同快照。不能把旧版本检索缺失判成历史数据丢失。

因此真实“memz vs 无记忆”实验还需要明确的历史→候选→审批→检索协议。所有当前结果只是 benchmark 准备证据。
