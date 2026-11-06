# memz 的公平评估协议（待运行）

后续开发状态（2026-11-06）：本次用户已授权继续开发；下面“本轮不恢复产品开发”等限制描述原研究阶段。现有 [memz adapter](MEMZ_ADAPTER.md) 可通过真实产品路径对显式获批事实运行有界检索，并独立评分 evidence；自动抽取／审批、真实语料接入和模型质量主实验仍未完成。下方“adapter 尚不存在”是历史背景，不能覆盖新实现或当前用户授权。

这是后续独立实验任务的预注册草案。只有离线数据加载和 BM25 通路已运行。本轮不授权付费模型实测，不恢复产品开发，不自动批准候选，不连接真实用户数据。

## 要回答的三个问题

1. 在同一 reader、同一题和明确预算下，memz 的回答质量是否保持？
2. 包含检索、生成、认证、来源读取、重试的逐题端到端延迟和总输入/输出 token 是否降低？
3. 把初次写入、抽取、embedding、维护及人工审批计入后，在真实的每份历史查询次数 Q 下，收益是否仍存在？

单独降低答案 prompt 长度、仅计 SQL 查询或排除失败题都不回答以上问题。

## 分成两个明确实验，不混称自动记忆效果

**A：原始历史到回答的完整系统比较（主实验）。** 每组收到同一原始历史，在不看测试题/答案/证据标签的前提下建立记忆，冻结后再查询。memz 若依赖 LLM/人工抽取、owner 批准，这些环节必须存在且记账。未开发这样的适配器前，memz 不能进入主实验出分。

**B：相同预制结构化事实的存储/读取消融（补充）。** 由不看题目的固定抽取器/审阅流程生成同一事实包，供 memz、平面 JSON/SQL 和词法检索读取。记录提取与审批的成本，但不把这种外部提供事实包的成绩宣传为 memz 自动理解原始聊天的能力。若用人工标注包，称人工结构化条件；所有对照也得到相同包。适配器不能用测试答案作为 value、不能用题干作为 subject，也不能借 gold evidence 选择 source。

保留事实审批轨迹是 memz 的产品语义。不能为了 benchmark 批量把任意原文伪装成“已批准的真事实”，也不能修改 server 取消审批。本轮只记录这个缺口，后续实验任务应确定处理协议。

## 比较组与必要消融

| 组 | reader 接收内容 | 用途 |
| --- | --- | --- |
| `no_memory` | 问题、必要时间/任务说明，无历史 | 明确无记忆下界；绝不叫原文全上下文 |
| `raw_full` | 原始历史，固定顺序和格式，完整放入 | 原始上下文基线；只有模型确实容纳时才成立 |
| `raw_budget_recency` | 相同预算内固定规则保留最近完整 turn/session | 长历史无法容纳时的实际预算基线；不得仍称 full |
| `bm25_raw` | 固定原文分块，词法排名取文，固定预算 | 判断记忆是否优于便宜的原文检索 |
| `memz_current` | 已批准版本 + 固定 provenance；现有子串策略 | 测当前可实现机制；保留空检索和失败，不偷偷语义改写 |
| `flat_same_facts` | 与 memz 完全相同事实包，平面检索/读取 | 区分事实提取、存储治理与上下文选择各自贡献 |
| `openviking_memory`（可选） | 同历史经 session commit 抽取后检索 | 固定单次 search/find 模式、rerank 开关；跟其它 reader 组同预算 |

OpenViking raw `add_resource` 可作为单独 `openviking_raw_rag` 检索消融，不能替代 `openviking_memory`。正式运行前补齐完整源树、运行依赖、隔离实例；不要用上游默认 prompt/judge 混入统一比较。

memz 现有子串检索的直接策略是完整题干作为 query，超过 200 UTF-16 units 记 `unsupported_query`，而不是静默截断。若选择 query rewrite，则把它作为单独组；固定提示、同模型/预算，计入 token 和延迟，不能由操作者根据答案选关键词。分页、provenance、认证与注销都计入；是否保持会话为明确操作点，不能只优化 memz 一组却不记录。

## 数据与隔离

- 首轮主线：LongMemEval-cleaned S 全 500 题、LoCoMo 全 1,986（另单列 category 1–4 的 1,540），MAB AR/CR 的固定官方 source 配置与全部符合项。oracle 只做 reader/评分链路上界检查，绝不进入 S 的记忆建库输入。
- 每个 LongMemEval question 的 haystack、每个 LoCoMo conversation、每个 MAB long-context row 是独立 scope，独立空白记忆状态。Q 为**该 scope 实际问题数**，不能跨不同 scope 摊销。
- 先 ingest 历史，再封存索引/批准事实映射、索引文件/DB 内容哈希及版本；之后才把 question 交给查询器。标签由单独 evaluator 加载。运行目录中的 gold 文件不挂载给 agent/检索进程；文件命名不是安全隔离本身。
- LongMemEval 只取 role/content/date，不把 `has_answer` 或 `answer_session_ids` 写入记忆。LoCoMo 不把 qa/observation/session_summary/event_summary 写入。保留图片 caption 的文本条件，统一禁用图片 URL 获取；真实多模态另起实验。
- MAB 保留 metadata.source 的官方筛选、句子分块/模型 tokenizer、context_max_length、顺序、demo/模板；source 只供任务组装，gold 与任务类型标签不作为 query 提示。非 gold 的任务必需辅助输入（如 TTL demos、previous-events）应按原协议同等提供，不能把通用 loader 的省略误认作完成复现。
- LoCoMo 只有 10 对话，调参使用明确划出的 conversation 组、最终评价用未调参组；报告拆分后的题数。全 10 对话结果如果用于多次调参就只能称探索性全量结果。MAB source/context 及 LME haystack 同样以组拆分，避免相同历史泄漏。

## 固定模型、预算和运行条件

保存 `experiment.template.json` 填成的不可变实际配置（本轮 null 字段尚未配置），SHA256 后写入每行结果。

- 固定 reader 的精确模型快照/weights revision、provider、部署版本、端点地区、tokenizer+chat-template hash、system/QA prompt hash、最大输出、reasoning effort、temperature、top-p、seed。固定抽取器、embedding、rerank 与 judge 的各自版本；不要求功能不同模型相同，但成本必须计全。
- 控制预算：所有方法共享 reader 总输入上限 B、输出上限和同一 prompt 开销；可用 memory budget = B − system/question/template tokens − output reservation。2K/8K/32K memory token 为建议的独立操作点，先用校验集冻结，测试不按单题调预算。
- `raw_full` 如果超出 reader 窗口，记 `context_overflow` 并报告覆盖率；主 matched-budget 比较使用 `raw_budget_recency`。不能只让完整原文失败而宣布检索更准确；也不能只挑可容纳的简单题而不报告筛选。
- 按 tokenizer 计算完整序列化 prompt 的确切 token；记录裁剪单位、截去的 doc/turn IDs、预算未利用量和截断标记。字节/字符/词数不能当模型 token。重复 provenance 文本先按现有 memz 行为计入；去重是单独消融，所有组用相同序列化规则。
- 单请求 latency 主试验 concurrency=1，同云区/资源/网络条件。吞吐另设并发 1/4/8，记录排队与资源；不把并发吞吐提升当单题 latency 提升。
- 索引构建后冻结，查询之间不学习答案、不追加 judge 结果；MAB 原有 chunk 顺序不可随机化。查询组顺序用 seed=42 随机的配对 blocks，组间交错运行降低外部负载漂移；至少 3 次重复，保留每次 run。temperature=0/seed 不保证云模型完全确定，应记录返回的模型指纹。
- cold 与 warm 分开：隔离实例冷启动/冷缓存、已有索引冷查询、同进程暖查询分别标记。provider prompt cache 能禁用时统一禁用；不能禁用则记录实际 cached tokens/策略/TTL 并单列 cached 与 uncached 成本，不能假定已关闭。保留所有工具/生成缓存命中状态。不给同一模型组偷用答案缓存。

## 记账与延迟边界

`results/*.template.csv` 是空表头，不含实测数据。每个实际 run 另存完整配置、JSONL 事件、请求 ID、模型 usage 原始回执（清除密钥/认证头）、prompt hash、检索 trace、答案与 judge 标签。

**索引表（每 scope 一行）**：原始字节/turns、parse、抽取、embedding、memory write、approval、维护、排队、ready 时间；所有模型调用输入/输出/embedding tokens、成功/失败/重试、storage bytes、人工操作分钟。OpenViking 在 commit 被接收时不能停止计时，要等背景提取/embedding task 完成并确认可检索。

**逐调用表（每次尝试一行）**：stage（extract/planner/embed/rerank/generate/judge）、attempt、request ID、实际模型、start/end、service/client elapsed、usage/cached/reasoning tokens、cache、失败码、计价版本。provider usage 缺失是 null，不能是 0；tokenizer 离线计数与计费 usage 分列。不把 LLM tokens 与 embedding tokens粗暴相加成单一可比 token 数；统一货币成本使用明确单价/日期。

**逐题表**：从收到 query 到完整 final answer 的 e2e（含认证、检索、provenance、预算、规划、工具、网络、重试、生成）；另外记录 retrieval、rerank、read、assembly、TTFT、完整生成与 token。用 monotonic clock；预填充和解码若 provider 不暴露则记 null，不猜测。judge 在离线评测成本里单列，不计入面向用户的 answer latency。阶段并行时不把 duration 简单相加冒充 wall-clock；记录实际 span。

**失败与完整分母**：提前固定每请求 timeout、最大 attempts（建议 2）和每题总 deadline（建议 120 秒，超长任务另行预注册）。超时、空检索、解析失败、overflow、证据缺失、部分写入、模型拒答和 provider 错误保留原始记录；重试产生的所有 token/时间计入。无响应题给全题质量分母计失败，同时另报服务可用率。拒答 benchmark 的正确拒答是质量成功，不能和基础设施故障混淆。judge 失败记 ungraded、追加统一重评，不能只删除难例。latency 报成功条件分布与含失败 deadline 的服务体验分布，注明右删失。

## 质量、统计与结论门槛

- LongMemEval：固定官方 judge 模型/提示的总 accuracy、每类 accuracy、abstention accuracy，以及独立 session/turn retrieval recall。不能以召回替代回答正确性。
- LoCoMo：运行固定官方分类 F1/拒答；额外统一 LLM judge 可单列，但不能和论文 F1或 OpenViking 宽松 judge 混称。category 5 独立报告；没有 evidence 的问题不当作 recall=1（某些上游代码默认这样处理，统一分析中应记 N/A 并说明）。
- MAB：严格保留 RESEARCH.md 的 source→metric 映射；parser 是否接受 `label: 43` 需事先固定，不能每个系统单独放宽。CR 按单跳/多跳/上下文长度拆分，保留与发布 gold 不一致的争议个例，主结果仍按官方 gold，另外做公开可复核的误差分析。
- 质量优先。建议预注册非劣界 delta=2 个百分点（只是待确认设计，非用户已接受阈值），用 scope 分组配对 bootstrap 的差值区间判断是否排除实质退化。LoCoMo 仅 10 scope，区间会宽，不能拿大量相关题当独立样本。F1用绝对量纲，不能与 accuracy pp 混算。
- latency 报 count、mean、p50/p95/p99、timeout率，跨重复 run 和 scope 给置信区间；不能把 8 题 smoke 的 p95 当可靠 tail latency。输入/输出 token、billed cache token、embedding、cost、storage分别报告，差值与比例用配对相同题集计算。
- 模型或上下文不足导致大量失败，先报告不可比范围，不发布“速度更快”结论。只有质量门槛通过且不隐藏索引/人工成本时，才能讨论具体工作负载上的优势。

## 摊销公式与工作负载

每个 scope 的一次性成本为 C_index，逐题成本为 C_query(i)，则：

`C_amortized(Q) = C_index / Q + sum(C_query(i), i=1..Q) / Q`

tokens 分输入/输出模型调用分别算，embedding 独列，金额再按固定单价换算。人工耗时不换算成模型 tokens，单独列分钟/等待时间。e2e cold session 总 wall-clock、ready 后逐题 latency 与总完成时间分别计算，不能把总索引 CPU秒直接加到并行墙钟秒。

`Q_break_even = ceil((C_index_memz - C_index_base) / (mean_Cquery_base - mean_Cquery_memz))`

只有分母为正且质量符合门槛时才有这个解释；额外索引成本非正的边界单独说明。实际 Q、Q=1/10/100/1000 的情境预测分开；没有实际多次 query 的预测必须标为估算。LongMemEval S 每个 haystack 通常 Q=1，不能把所有题当共享索引。LoCoMo/MAB 的注入一次、查询多次天然更适合验证 break-even。重复题答案缓存不算新的独立查询。

## 最小试跑与全量运行命令

**现在可运行的离线命令**在 README；原准备环境已完成 8 题及全 1,986 题，数据和逐题输出不随仓库分发。新 checkout 先获取并校验公开数据，再复现。真实模型试验需要另一个获得正式授权的任务。

未来最小真实 smoke：从未调参 scope 取 LoCoMo 每类至少 1 题、LME 的更新/时间/拒答各 1–2 题、MAB 一个 CR 6k context 的固定 query 子集；每组用同一清单。先核对模型输入无 gold、隔离状态、usage 回执、索引 ready、timeout 行和 scorer，再扩大全量。选题清单在 evaluator 侧生成并锁定 SHA，不把 category 写入模型 prompt。

以下是**已存在的上游命令入口**，尚未运行。先按 README 将官方源码 checkout 到 `sources/` 并固定版本；从本目录设置 `BENCHMARK_ROOT="$(pwd)"`。此处未安装上游依赖，也未配置模型，不能直接出结果：

```sh
# OpenViking 单次检索 memory QA（其自身协议；不要混当统一比较已实现）
cd "$BENCHMARK_ROOT/sources/OpenViking"
python benchmark/locomo/openviking/import_to_ov.py \
  --input ../../data/locomo/locomo10.json --parallel-samples 1 \
  --success-csv ../../reports/ov-import.csv --error-log ../../reports/ov-import-errors.log
python benchmark/locomo/openviking/run_eval.py ../../data/locomo/locomo10.json \
  --sample 0 --question-index 0 --threads 1 --output ../../reports/ov-qa-smoke.csv
# 全量：不带 sample/question-index，仍保留固定低并发与实际预算配置
python benchmark/locomo/openviking/run_eval.py ../../data/locomo/locomo10.json \
  --threads 1 --output ../../reports/ov-qa-all.csv
python benchmark/locomo/openviking/judge.py --input ../../reports/ov-qa-all.csv --parallel 1 --strict-prompt
python benchmark/locomo/openviking/stat_judge_result.py --input ../../reports/ov-qa-all.csv

# LongMemEval 官方检索基线；需独立安装完整依赖，使用实际数据文件
cd "$BENCHMARK_ROOT/sources/LongMemEval"/src/retrieval
bash run_retrieval.sh ../../../../data/longmemeval-cleaned/longmemeval_s_cleaned.json flat-bm25 session

# 固定 reader 的生成结果已由未来统一实验器输出后，用官方 judge：
cd "$BENCHMARK_ROOT/sources/LongMemEval"/src/evaluation
python evaluate_qa.py gpt-4o ../../../../results/ACTUAL_RUN/hypotheses.jsonl \
  ../../../../data/longmemeval-cleaned/longmemeval_oracle.json
```

LME hypothesis JSONL 格式为 `{question_id,hypothesis}`，按原始官方 ID 导出；本任务规范化 ID 包含 scope 前缀，必须明确映射回去。本 commit 的 judge 输出是 `<hyp_file>.eval-results-gpt-4o`，不是 README 旧示例中的 `.log`；gpt-4o alias 在源码绑定 `gpt-4o-2024-08-06`，可用性/授权后续核实，不能悄悄更换 judge。

OpenViking 以上默认预算只是流程示意；正式比较必须显式采用已经锁定的检索/上下文/rerank/model 配置。同理 MAB 应从 `python main.py --agent_config CONFIG --dataset_config CONFIG` 的官方入口接入固定本地 parquet loader，不能运行硬编码 main 的在线 loader。V2 在数据准备后用 `evaluation/scripts/run_no_retrieval.sh` 等官方 wrapper；其模型、截图、token 预算和 LAFS 与统一端到端账本分别报告。

**memz 全量真实实验命令尚不存在**。后续任务需在本任务目录内写实验 adapter/runner，确定输入抽取、审批和 scope→隔离项目/数据库映射，再提供实际 `smoke`/`all` 参数。现在编造一个不存在的 `run_memz_eval` 命令会掩盖主要适配缺口。当前只读接口可按 `../../docs/context-client.md` 调用，但未接入真实 benchmark 记忆状态：

```sh
cd "$BENCHMARK_ROOT/../.."
MEMZ_QUERY='公开测试题的原文' npm run --silent demo:context
```

该命令只读已有演示数据，不是 benchmark 分数；不得把它输出当作已完成主实验。本轮没有运行它或写入数据库。
