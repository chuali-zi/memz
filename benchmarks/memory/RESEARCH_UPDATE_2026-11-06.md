# Memz 记忆系统研究更新（2026-11-06）

核查日期：2026-11-06 UTC。分析基线：`148622bc84a82289beaab80f95da455fb44822d2`。本记录是研究与设计建议，不是性能报告；研究子任务未运行第三方系统、未下载 benchmark 数据、未调用付费模型、未导入第三方源码、未部署。主任务的数据与测试状态另见 [本轮优化记录](OPTIMIZATION_2026-11-06.md)。后续同一工作区的产品改动和测试结果应由对应实现报告提供，不能倒填为本研究的复现结果。

已阅读本项目 README、`RESEARCH.md`、`EVALUATION_PLAN.md`、`sources.lock.json`、`server.js` 与 `scripts/context-client.js`，并检查本地适用的 AGENTS.md / skills，未发现额外仓库指令。研究使用官方论文网页及 GitHub 只读插件；精确版本、日期、许可、文件范围记录在 [新增来源清单](research-sources-2026-11-06.json)。既有来源锁不被本文件覆盖。

后续实现记录：多关键词的显式字面匹配见 [lexical-retrieval.md](../../docs/lexical-retrieval.md)；第三轮本地优化的候选比较、单页快照与来源传输合同见 [snapshot-context.md](../../docs/snapshot-context.md)。下文保留首轮分析基线和当时的实施状态，后续改动不作为本记录新增的论文复现或模型评测成绩。

## 1. 最值得实施的两项改进

**第一项：有界批量读取固定修订的 provenance。** 基线客户端对 N 条事实需要 N+3 个 HTTP 请求：登录、事实页、N 次逐条来源、注销。本轮落实可选批量路径，每批最多25个 `(factId,version)` 引用，在单个 REPEATABLE READ 只读事务内检查权限并查询完整来源；事实页仍是前一个请求的快照，不能声称整页与所有批次共享一个快照。因为修订和来源不可变，各引用仍固定到事实页所见版本。保留原接口和默认输出，HTTP 往返收益由独立合成实验验证。

**第二项：显式 schema v2 的共享来源字典。** 本轮已独立实现 `sourceMode:deduplicated`：每项事实保留 sourceId、revisionId 和批准信息，同一返回页内的完整 source 只序列化一次，能无损恢复旧结构。预算装配只保留事实最大完整前缀及它们实际引用的来源。它不做生成摘要、不删证据，也不改变审批。来源各不相同时字典可能增加开销，因此不能承诺任何输入都节省。

两开关形成 individual/inline、batch/inline、individual/deduplicated、batch/deduplicated 四组消融。来源去重仅发生在最终上下文；batch HTTP 响应仍包含各项完整来源。输出 JSON 的字段、换行、缩进、中文、emoji、转义与预算元数据都计入 UTF-8 字节，`maxOutputBytes` 不是 token budget。

**预算早停暂缓。** 基线合同要求整页 provenance 全部验证后才能成功，即使某项最后被预算省略，其读取失败也必须使请求失败。懒读取会掩盖这类失败，不能作为行为等价的透明优化。若以后引入，必须单列 opt-in 合同、解释省略项未验证，并重新设计失败/续读测试。更强的单请求事实与来源共同快照也留作未来独立模式。本轮选择保留旧错误语义，先完成两个风险较低的优化。

## 2. OpenViking：哪些机制真的存在

本节固定 [OpenViking 739e17f（2026-11-05）][ov]，与仓库既有锁一致。本次另观察到 main 已到 `dfb9eb8`（2026-11-06），但没有用更新的 main 偷换本节机制证据。核心代码许可 AGPL-3.0；examples、集成与第三方目录有单独条件。本项目仅独立实现设计，不复制其实现。

### 分层表示与检索不能混称

L0 `.abstract.md`、L1 `.overview.md` 是**目录级**语义侧文件，并非每个普通文件各有一套；L2 是原文件或解析后的正文。L0/L1 常一同生成，但可以单独存在。默认生成正文预算是 256/4,000 字符，并非模型 token，也不是严格存储上限：为保留完整句子可能超出预算。父摘要的 freshness 统计只覆盖直接子项；较大目录可累计变更后再刷新，不能认为摘要始终等于最新全树。L2 若来自 PDF 解析也不等于原始 PDF 字节无损保存。[上下文层文档][ov-layers]

当前 `HierarchicalRetriever` 每个 query 做一次全局向量召回，先施加目录/权限/类型/level 范围，可选 rerank。QUICK 召回 limit，THINKING 在可用 reranker 下召回 2×limit 再返回最多 limit。当前路径没有旧版递归优先队列、父子分数传播、收敛轮次。单 query 内源码按 URI 保留最佳命中；`search` 的多规划查询聚合则不保证跨 query 去重，limit 也是每个规划 query 的 limit。不能把这两层去重混为一谈。[检索文档][ov-retrieval]、[实现][ov-retriever]

`find` 是无 session 意图规划的单查询 QUICK 路径；`search` 可基于摘要、最近消息及问题用 LLM 生成多个 TypedQuery。规划器、embedding、reranker 都要记成本。普通 search 的排序与 context 装配也不是同一接口；前者不能因类名而声称具备后者的预算与跨轮策略。

### Context 装配：可借鉴，也要保持自己的合同

`context_assembler` 把召回、读取、层级选择、渲染放进单请求管道。预算策略先给多个候选较浅表示，再用余量加深；较大层级退回较浅层级，而不是把正文任意剪断。渲染的 envelope 也计入估算。它使用 CJK-aware 字符权重的 `estimate_text_tokens`，不是目标模型的精确 tokenizer。[预算代码][ov-budget]、[渲染代码][ov-render]、[估算函数][ov-token]

其 RecallLedger 对最近若干 turn 中已经返回的 URI 做 best-effort 冷却，失败可退化为不去重。该方法不能原样套进 memz：相同 fact ID 可以有新批准修订；reader 也可能已丢失先前窗口。若将来研究跨轮去重，至少需要 project/fact/revision/source 标识、reader 上下文保有确认和失效规则，否则节省字节会变成遗漏更新。[ledger][ov-ledger]

memz 本轮应保持完整来源前缀合同。L0/L1 导航或按需正文可做未来独立模式，输出必须明确“摘要/引用”与“完整证据”的区别，给出固定版本的补读接口。不能无声地用生成摘要替换现有来源全文。

### Session memory 与维护

生命周期是 create → add_message → commit。commit 的归档阶段同步保存消息和入队，返回 task_id；摘要、记忆提取、memory_diff 与完成标记在后台处理。accepted 不代表记忆已经可检索。现有记忆参与抽取，提议可能创建、编辑、合并、删除；memory_diff 区分实际改动、跳过操作和无效/no-op，便于诊断。[会话文档][ov-session]

源码把抽取上下文准备、只读探索、结构化操作解析及实际写入分开；session context provider 允许读取/搜索已有记忆，最终生成操作计划，MemoryUpdater 再执行。不能根据模块注释“single LLM call”断言整次 commit 只花一次调用：extract loop 有工具探索、校验修复和重试；updater 也显式表达部分写入失败，不能把自然语言中的“atomic plan”当数据库级全有全无保证。[提取上下文][ov-provider]、[extract loop][ov-loop]、[updater][ov-updater]

对 memz 的可取设计是**模型产出候选计划，确定性执行器验证，owner 批准后生成不可变修订**；抽取失败、无候选、校验跳过、版本冲突、实际批准要作为不同状态记录。自动摘要/关联/合并不能获得绕过批准的路径。将来抽取 adapter 应输出 sourceId、精确片段位置、subject/predicate/value、expected_version、提取器/提示版本及输入哈希，接现有 proposal-client；每项来源定位应在确定性层检查。

## 3. OpenViking 背后的三篇论文

下述是**作者提出的机制**，不等于本项目复现，也不等于所有能力都存在于上述开源提交。

- [VikingMem，2605.29640v3，2026-06-12][vikingmem]：事件是从原始会话选择出的语义单元，实体状态是由事件驱动的持久视图；schema 指定事件属性如何通过算子更新实体，算子包含确定性聚合和模型合并。其多类型提取减少反复阅读同一历史，并研究时间压缩与带时间权重的召回。论文基于 VikingDB，明确 OpenViking 只开放核心能力的子集。对 memz 的价值是“原始证据—候选事件—已批准状态”分层及提取/维护成本账本；时间衰减不能替代批准语义，旧但仍有效的决定不能因不常访问被忘记。
- [Directory-Aware Query and Maintenance，2606.16903v1，2026-06-15][directory-paper]：DSQ 定义目录范围检索，DSM 定义目录结构维护；TrieHI 在向量执行器之上保留原生前缀树，避免反复展开路径及子树改名造成的大量更新。论文描述的目录递归语义与当前 Python retriever 的“全局排名、目录过滤”不矛盾：范围解析和候选打分是两个层次。memz 目前项目+事实结构简单，没有目录移动负载证据，不需要为了借鉴而先引入 TrieHI。
- [VikingRAG，2609.11390v1，2026-09-10][vikingrag]：从证据缺口触发多轮结构化文档检索，把历史检索轨迹保存成 experience edges，再对相似问题复用；先尝试单轮，证据不足才升级。这是文档 RAG，不是 session 事实抽取。可借鉴“先便宜路径、缺证据再追加”的接口设计，但 memz 的复用必须按批准修订失效，实验还须隔离训练轨迹与测试查询，不能把同题答案缓存当记忆能力。

三篇论文分别研究记忆状态、目录索引、文档证据获取。它们的实验对象、模型、指标和成本口径不同，不能取最好的数字拼成一个 OpenViking 或 memz 的综合成绩。

## 4. 其他体系的适用部分与实际局限

### MemGPT / Letta：让有限窗口可管理，不等于批准式事实库

[MemGPT v2（2024-02-12）][memgpt] 区分窗口内主上下文与外部 archival/recall，通过工具调用取回、写入和驱逐内容，并以 heartbeat 串联多步操作。其启发是显式工作集、可续读与真实外部存储；“虚拟无限上下文”不保证完整召回或正确更新，多次模型循环也会增加成本。

版本边界很重要：[letta-ai/letta@8816d3a][letta-old] 当前 README 已将活跃实现指向 [letta-code@67f3bbc][letta-new]，旧 V1 server 留在 archive 分支。当前 Letta Code README 提到 memory blocks、git 跟踪的 MemFS、message search 和 dreaming；这是当前产品文档核查，未审计完整运行时，不能把 2023/2024 论文直接当其现行完整实现。memz 可借鉴工作集/持久层分离和可审计的派生物版本，但模型自改 memory blocks 与 owner 批准事实不是相同治理条件。

### A-MEM：元数据与关联可以是派生索引

[A-MEM v11（2025-10-08）][amem-paper] 为原文笔记生成关键词、标签、上下文描述，先用 embedding 找相关旧笔记，再用 LLM 建链接并演化旧笔记的表示。对 memz 可把这些内容作为**可重建的候选检索元数据**，绑定确切修订；检索命中不能使其成为批准事实。

[agiresearch/A-mem@ceffb86][amem] README 明确该库是记忆组件，论文复现另指向 AgenticMemory。实际 `search_agentic` 先加入最多 k 个直接命中，再追加邻居，最终又切到前 k 项：在已有 k 个直接命中时，追加邻居不会进入最终输出。这是静态代码观察，未运行复现；它说明不能仅凭“agentic/graph”命名就断言链路一定提供邻居增益。元数据演化也没有 memz 的审批/不可变修订约束。[具体实现][amem-code]

### Mem0：2025 论文与 2026 实现必须分开

[2025 Mem0 论文 v1][mem0-paper] 描述抽取候选后检索相似记忆，再由模型决定 ADD/UPDATE/DELETE/NOOP，并研究图扩展。这是论文版本机制；其 LoCoMo 质量、token 与 p95 改善都是作者特定条件的报告，不是 memz 的证据。

[当前 mem0@ed1f10f（2026-11-04）][mem0] 已改为追加式提取。源码的普通推断路径取近期消息和相似旧记忆，用一次 additive extraction 调用产出新记忆；公共管理 API 仍有 update/delete，不能说整个 SDK 禁止修改。搜索计算语义、BM25、实体信号，但本次检查的 `_search_vector_store` 最终候选来自语义结果池，再加词法/实体分数；不能简单称为完整的 BM25+向量候选并集。不同后端关键词能力还会影响实际效果。[源码][mem0-code]

README 的新算法表明确来自含私有优化的托管平台，不能承诺开源 SDK 得到同分。本项目可借鉴多信号消融和 explain 追踪；追加式存储本身不能解决“哪个批准值当前有效”，更不应把 agent 声称完成的动作直接当作 owner 批准。

### Zep / Graphiti：有效时间与入库时间是不同轴

[Zep 论文 v1（2025-01-20）][zep-paper] 从 episodes 保存原始输入，抽取实体/关系，并用有效时间与系统录入/失效时间表达状态变化；发生时间不等于系统何时知道它。Graphiti 用模型识别矛盾并使旧边失效，仍依赖抽取和消歧质量，不能由存储结构推出事实可靠性。

[graphiti@747b480（2026-11-06）][graphiti] 的 EntityEdge 保留 episodes、valid_at、invalid_at、expired_at、reference_time；字段说明还区分计划的成立时间与未来发生时间、软截止日与失效日。[字段实现][graphiti-edges] memz 若将来做“截至某时”的回答，应区分审批时间、事实有效时间和查询快照，不能把 revision.created_at 自动当业务生效日。当前阶段先明确“当前已批准”的界面语义，避免无证据增加时态功能。Zep 产品与 Graphiti 库也不是同一被测系统；当前库根 LICENSE 核实为 Apache-2.0。

## 5. 最新原始研究对 memz 的具体提醒

[When Retrieval Is Not Enough，2610.36308v1（2026-10-26）][obsolete] 在 MemoryAgentBench 的单跳 FactConsolidation 中发现，正确更新已被召回时，旧冲突值仍可误导 reader；等大小替换实验把无关语句替成旧值后出现退化。该结论限于其合成规则、模型与历史：gold-assisted support 是事后诊断，74 个冲突问题也曾用于 prompt 开发，并非独立留出集。不能宣称已证明所有 RAG 或 memz 的效果。它支持本项目把“最新依据是否存在”和“回答是否误用旧值”分开测量。

[LongMemEval-V2，2605.12493v1（2026-05-12）][lme-v2] 将静态状态、动态状态、流程、环境陷阱、错误前提分别测试，以固定 reader 消费紧凑证据；论文也报告 agentic 方法的延迟代价。对本项目的启发是对错误前提显式拒答，而非只要有相关文本就回答；当前纯文本、已批准事实读取并不覆盖其完整多模态轨迹能力。

还需注意 memz 自身的边界：**只返回当前 revision 不代表来源全文不含过时、被驳回或恶意文本**。例如支持当前值的会议原文可能同时讨论旧方案。完整 provenance 是审计依据，不是自动净化后的模型指令。既要保持原文完整，也要明确标注当前批准值与不可信来源角色；是否足以降低 reader 的旧值错误，仍需真实模型实验。

## 6. 可消融路线与验收条件

| 优先级 / 实验 | 改什么 | 保持什么 | 主要证据 |
| --- | --- | --- | --- |
| P0 `transport_batch`（已实现） | 每批同事务读取固定版本依据 | 原事实页、ID 顺序、事实/版本/来源 | 请求数、读取延迟、字节、旧版本并发回归 |
| P2 `budget_early_stop`（暂缓） | 预算满后停止后续 proof 读取 | 需另定未读取项的失败合同，不能称默认行为等价 | 完整前缀、续读、未验证项与失败统计 |
| P0 `source_dictionary`（已实现） | 共享原文一次输出 | 无损 source 引用、全部批准元数据 | 独立 schema；重复/唯一 source 两种负载；完整 prompt token |
| P1 `derived_lexical` | 显式词法候选检索模式 | 当前批准版本、项目隔离、原有 substring 默认行为 | 命中覆盖、无答案比例、中文与同义表达失败；不是语义搜索成绩 |
| P2 `derived_summary` | 可重建摘要/标签/链接 | 原始来源不变、revision 绑定、批准仍确定性 | 抽取成本、失效更新、stale-summary、证据覆盖与 reader 质量 |
| P2 `semantic_hybrid` | 词法/向量候选、融合/可选 rerank | 权限在候选进入 reader 前生效、明确排序游标 | 各通道召回、候选并集、重排增益、embedding/rerank 总成本 |
| P2 `proposed_extraction` | 历史→有依据候选→owner 决策 | 不自动批准、不接触 gold | 提取精确度/漏提、来源片段可定位、审批工作量、ready latency |

P0 合同回归应覆盖：中文/emoji/JSON 转义、预算恰好等于完整输出与少一字节、空结果、第一项过大、中间大项、共享来源、末页与续页、并发批准时修订固定、角色/RLS 隔离、错误来源归属与事务失败。旧接口对同一冻结状态应可充当等价 oracle。若新增同事务接口，跨请求续页依然不是共同数据库快照，文档不能扩大保证。

性能报告至少分 N=0/1/25/100，来源短/接近上限，重复与唯一来源，预算宽/紧，成功/失败路径；说明本机/网络 RTT、并发、冷暖、样本数。批量减少请求数不保证在所有 N 和负载下更低 wall-clock。可测受控网络 RTT 的敏感性，但模拟值必须与真实 HTTP 测量分列，不能用公式直接生成“实测加速比”。

检索策略是另一轴。当前整段子串不能稳健回答完整自然语言问题，但直接改成排序搜索会改变 fact.id 游标语义；应提供明确新模式及稳定游标设计。先从不调用模型的词法检索做消融，再决定是否值得加入向量和 reranker，避免把传输改进与质量策略同时改变而无法归因。

## 7. 评测边界与下一步条件

继续沿用 [公平评估协议](EVALUATION_PLAN.md) 的两条实验：A 为原始历史→抽取/审批→回答的完整系统；B 为所有方法得到相同预制事实包的存储/读取实验。当前 P0 只能直接支持 B 的工程改进。来源、候选和审批不应由测试题、答案或 gold evidence 帮忙选择。

OpenViking 对照必须区分 session commit→memory extraction→recall 与 add_resource→resource RAG；LoCoMo 的同一原始材料不足以让二者成为同一任务。VikingBot、不同 Agent 集成、mem0 风格单轮 QA 的 QA/judge 均不同，不能横比分数。官方 runner 有重导入/目录保留及递归删除风险；本次没有执行任何 runner。[官方评测入口][ov-benchmark]

需要保留的指标包括：最新批准版本覆盖、旧值答案率、来源忠实性、正确拒答、正常与失败题的完整分母；同时记录抽取、embedding、重排、维护、审批、检索、来源读取、reader 和 judge 的成本边界。按实际 scope 的查询数摊销，不能跨不同独立历史共享索引成本；模型 usage 缺失记 null，不能计零。字节、估算 token、精确 tokenizer token 和计费 token 分开记录。

本次没有新的真实模型质量/速度/token 优势结论。LoCoMo 的既有 CC BY-NC 4.0 限制仍保留；HF 数据下载在此前环境遭 CONNECT 403 的事实不因网页可浏览而解除，本次未尝试绕过。后续需要实际原始历史适配、经过冻结的抽取与审批协议、授权模型配置及可用数据，才能运行完整系统比较。

[ov]: https://github.com/volcengine/OpenViking/tree/739e17f9172b9f595bfe4cc95293ec52d4686120
[ov-layers]: https://github.com/volcengine/OpenViking/blob/739e17f9172b9f595bfe4cc95293ec52d4686120/docs/en/concepts/03-context-layers.md
[ov-retrieval]: https://github.com/volcengine/OpenViking/blob/739e17f9172b9f595bfe4cc95293ec52d4686120/docs/en/concepts/07-retrieval.md
[ov-retriever]: https://github.com/volcengine/OpenViking/blob/739e17f9172b9f595bfe4cc95293ec52d4686120/openviking/retrieve/hierarchical_retriever.py
[ov-budget]: https://github.com/volcengine/OpenViking/blob/739e17f9172b9f595bfe4cc95293ec52d4686120/openviking/retrieve/context_assembler/budget.py
[ov-render]: https://github.com/volcengine/OpenViking/blob/739e17f9172b9f595bfe4cc95293ec52d4686120/openviking/retrieve/context_assembler/render.py
[ov-token]: https://github.com/volcengine/OpenViking/blob/739e17f9172b9f595bfe4cc95293ec52d4686120/openviking/utils/token_estimation.py
[ov-ledger]: https://github.com/volcengine/OpenViking/blob/739e17f9172b9f595bfe4cc95293ec52d4686120/openviking/retrieve/context_assembler/ledger.py
[ov-session]: https://github.com/volcengine/OpenViking/blob/739e17f9172b9f595bfe4cc95293ec52d4686120/docs/en/concepts/08-session.md
[ov-provider]: https://github.com/volcengine/OpenViking/blob/739e17f9172b9f595bfe4cc95293ec52d4686120/openviking/session/memory/session_extract_context_provider.py
[ov-loop]: https://github.com/volcengine/OpenViking/blob/739e17f9172b9f595bfe4cc95293ec52d4686120/openviking/session/memory/extract_loop.py
[ov-updater]: https://github.com/volcengine/OpenViking/blob/739e17f9172b9f595bfe4cc95293ec52d4686120/openviking/session/memory/memory_updater.py
[ov-benchmark]: https://github.com/volcengine/OpenViking/blob/739e17f9172b9f595bfe4cc95293ec52d4686120/benchmark/README.md
[vikingmem]: https://arxiv.org/html/2605.29640v3
[directory-paper]: https://arxiv.org/html/2606.16903v1
[vikingrag]: https://arxiv.org/html/2609.11390v1
[memgpt]: https://arxiv.org/html/2310.08560v2
[letta-old]: https://github.com/letta-ai/letta/blob/8816d3a8516893bfdc0fa14bfb1235226012e295/README.md
[letta-new]: https://github.com/letta-ai/letta-code/blob/67f3bbc867fcce4e6f4849dcb6cbd3ab179c190d/README.md
[amem-paper]: https://arxiv.org/html/2502.12110v11
[amem]: https://github.com/agiresearch/A-mem/tree/ceffb860f0712bbae97b184d440df62bc910ca8d
[amem-code]: https://github.com/agiresearch/A-mem/blob/ceffb860f0712bbae97b184d440df62bc910ca8d/agentic_memory/memory_system.py
[mem0-paper]: https://arxiv.org/html/2504.19413v1
[mem0]: https://github.com/mem0ai/mem0/blob/ed1f10fc87080f0b67f99be370817504888462ab/README.md
[mem0-code]: https://github.com/mem0ai/mem0/blob/ed1f10fc87080f0b67f99be370817504888462ab/mem0/memory/main.py
[zep-paper]: https://arxiv.org/html/2501.13956v1
[graphiti]: https://github.com/getzep/graphiti/tree/747b480ec6b12ecb718f1e2bc588b20ee36ea9c2
[graphiti-edges]: https://github.com/getzep/graphiti/blob/747b480ec6b12ecb718f1e2bc588b20ee36ea9c2/graphiti_core/edges.py
[obsolete]: https://arxiv.org/html/2610.36308v1
[lme-v2]: https://arxiv.org/html/2605.12493v1
