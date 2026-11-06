# 离线检索诊断与 reader 输入导出

这些标准库脚本比较公开历史上的原文检索策略，**不是 memz 实现、生成答案质量评测或官方 BM25 的精确复现**。不访问网络、不调用模型、不读取凭据，不修改产品数据。沿用 [prepare.py](scripts/prepare.py) 的 corpus/query/gold 三文件格式。数据来源与许可继续遵循 [README](README.md)；LoCoMo 为 CC BY-NC 4.0，数据、逐题检索结果、导出 context 和逐题 evidence 不提交仓库。

## 可复现命令

Python 3.10+，无需额外依赖。从仓库根目录运行，先按 README 获得并验证合法的本地数据副本。以下路径均必须是新路径；复跑换路径，不能覆盖已有文件。

```sh
python benchmarks/memory/scripts/retrieval_run.py \
  --corpora benchmarks/memory/prepared/locomo/corpora.jsonl \
  --queries benchmarks/memory/prepared/locomo/queries.jsonl \
  --output benchmarks/memory/reports/locomo-bytes8192-run1 \
  --budget-bytes 8192 --seed 42 --dev-scopes 2 --split all

python benchmarks/memory/scripts/retrieval_score.py \
  --run benchmarks/memory/reports/locomo-bytes8192-run1 \
  --corpora benchmarks/memory/prepared/locomo/corpora.jsonl \
  --queries benchmarks/memory/prepared/locomo/queries.jsonl \
  --gold benchmarks/memory/prepared/locomo/gold.private.jsonl \
  --output benchmarks/memory/reports/locomo-bytes8192-score1 \
  --bootstrap-samples 2000 --seed 42
```

独立预算点使用 `--budget-bytes 2048`、`8192`、`32768`，分别保存结果。它们是 **2/8/32 KiB UTF-8 bytes，不是 2K/8K/32K 模型 tokens**。`--split dev` 或 `test` 只运行对应 scope，`all` 会运行全部，并在汇总中分列 all/dev/test。先在 dev 决定参数，再冻结后运行 test；如果查看 test/all 后调参，后续这些结果必须标为探索性，不能仅因分组命名而宣称盲测。

开发 scope 按 `sha256(str(seed) + NUL + scope)` 升序选前 `dev-scopes` 个，余下为测试组；配置完整保存映射。默认 seed=42、dev-scopes=2，LoCoMo 得到 2/8 个 scope。小型合成集应显式设 `--dev-scopes 0` 或至少留出一个测试 scope；完全空输入可运行并得到空结果。数据顺序不改变 split。每题四方法的执行顺序由独立 `random.Random(seed)` 打乱，问题本身保留原文件顺序。单进程、串行、无重试；重复运行使用新目录，分别保留计时，不能把重复题当独立统计样本。

## 方法、预算与上下文

| 方法 | 选择规则 | 公平性与解释 |
| --- | --- | --- |
| `no_memory` | 空 context | 无记忆基线；仍记录预算未使用量 |
| `raw_full` | 原顺序全部文档 | **不受预算约束**，`raw_no_budget_unfair=true`；仅检索覆盖参考，不能声称任何 reader 可以容纳 |
| `raw_budget_recency` | 由新到旧贪心选完整文档，再按原顺序呈现 | 使用与 BM25 相同的字节预算 |
| `bm25_raw` | 正分文档按分数降序，同分按原顺序，贪心选完整文档 | 自有词法检索，不是 memz，不使用 gold、摘要或候选审批 |

“完整文档”由 prepare.py 决定：LoCoMo 为完整 turn；LongMemEval 为完整 session；当前 MAB loader 为整段 context。本脚本不擅自把后两者改成 turn；因此这些输入的操作点不可直接与 LoCoMo 的 turn 预算解释混同。所有方法共用格式 `[id] session=session_id date=date\ntext`，文档间两个换行。预算包含该格式的 ID、session、date、文本和分隔符，按最终 UTF-8 序列长度精确计算，不包含 question/system/template。超预算候选整块跳过后继续尝试下一块，绝不截取 Unicode 字节、切碎 turn 或强行填充到预算。记录跳过的候选 ID 和预算未使用量；BM25 零分文档不进入候选集。

BM25 只对原始 `text` 建词项：Python Unicode `lower()` 后 `re.findall(r'\w+', text)`，不做词干化、停用词过滤、语义改写、embedding 或 rerank；查询重复词只计一次。固定 `k1=1.5, b=.75`，IDF 为 `log(1 + (N-df+.5)/(df+.5))`。倒排表加速正分候选，词项排序保证跨进程确定的浮点累加顺序。没有邻居/session 扩展。它是可复核的低成本诊断基线，不代表官方系统的调参最佳值。

## 数据隔离与结果

runner 只接受显式 `--corpora` 和 `--queries`，没有 gold 参数，且在读取题目之前完成所有 scope 的 BM25 建库。corpus/document/query 字段严格白名单，注入 answer、category、evidence 或其他元数据会在创建结果目录前被拒绝。重复 scope、文档 ID、query ID 和未知 query scope 同样拒绝。文档 ID 只要求 scope 内唯一。

这是代码路径和进程职责隔离，**不是操作系统级访问控制**。如果需要物理隔离，应给 runner 进程只挂载 corpus/query 和脚本，gold 仅挂载给另一个 scorer 进程；不能把 `.private` 文件名当安全边界。测试会拦截 runner 的所有文件打开操作，确认不曾打开 gold。文本中本来出现的普通词 “answer” 不会因字段白名单而被误删。

运行目录：

- `manifest.json`：完整配置、固定 scope 映射、题目清单、输入/代码 SHA256、Python/平台版本、配置哈希。
- `index.jsonl`：每 scope 的 BM25 建库计时、文档数、索引哈希和大小代理。大小代理是倒排表/长度/平均长度的规范 JSON 字节数，不是 RSS、实际数据库占用或持久化索引大小。原文的序列化字节另列。计时仅覆盖 BM25 构建，不含原文读取/解析、代理序列化或生成，也不代表所有方法的总启动成本。
- `retrieval.jsonl`：每题每方法的检索 ID、跳过的预算候选、context SHA256/bytes、预算、完整检索与拼接计时、错误。context 本身可由输入和 ID 重构，不重复存入这里。

配置哈希和检索内容可重现；机器/计时本来会变化，不能要求含计时文件逐字节相同。每次请求异常保留一行失败与空 context；没有因空检索而丢弃问题。当前测得的 `retrieval_assembly_ms` 是同进程已建库后的本地检索和上下文拼接，**不是完整生成端到端延迟**。输入/输出模型 token、模型成本、generation、end-to-end generation、answer quality 全部为 `null`。只有确实未调用的模型调用次数为 0。

## 独立评分和统计

scorer 检查 corpus/query 哈希、scope 映射、全部预期问题、方法、结果唯一性及重构 context 的哈希/字节/预算。缺失的逐题结果保留为 `missing_trace` 失败，并在有 evidence 的质量分母中计 0；错误 scope、重复结果或被改动的 context 直接拒绝。gold 缺题或重复 ID 拒绝，避免悄悄改变分母。

对每题原始 `evidence_ids` 的不同字面引用形成集合。重复字面引用只计一次，并单列重复数量；不 strip 空白、不拆分 `"D1, D2"`、不纠正拼写、不推断缺失 ID。无法解析的引用仍进入严格分母并计未命中。list 中的异常 JSON 值保留原样并标为 unresolved；evidence 容器不是 list 则显式报错，不擅自转换。LoCoMo 的 9 个已知无法直接匹配引用不在检索过程中修复。

严格指标只对 evidence 非空的问题定义：

- `evidence_any_hit`：至少一个原始引用命中。
- `evidence_all_hit`：所有原始引用都命中；有 unresolved 引用时不可能得到 1。
- `evidence_recall`：命中的不同引用数 / 全部不同原始引用数，再对合格问题取宏平均。

辅助 `resolved_any_hit/all_hit/recall` 只使用能在该 scope 找到的引用；没有任何可解析引用的问题为 N/A。每个指标独立给 `denominator_queries`、scope 数、有效 scope 数；同时报告总引用数、可解析引用数、空 evidence 问题数、unresolved 问题数和全可解析问题数。**辅助指标不能替代严格指标。** 无 evidence 的题（包括许多拒答题）不当作 recall=1，也不能凭检索给答案正确性评分。category 逐类分列，包括 category 5。

汇总 `summary.json` 给 all/dev/test 及各 category 的点估计、上下文字节/检索延迟分布、索引大小代理和建库时间；逐题 `scores.private.jsonl` 含原始 evidence 诊断，继续留在忽略目录。scope cluster bootstrap 以 scope 为单元有放回采样，每次保留该 scope 的全部问题，以 query 加权的宏平均为估计目标。使用固定 seed、默认 2,000 次，百分位 95% CI。全 N/A 抽样不产生数值，显式报告有效 bootstrap 次数。每组还报告相对 `raw_budget_recency` 的逐题配对差及相同的 scope bootstrap CI，方向为“该方法减 recency”；`raw_full` 的配对结果继续携带不匹配预算标志。

LoCoMo 只有 10 个 scope，dev 更只有 2 个，bootstrap 不创造额外独立样本；这些 CI 是描述性的，不能据此宣布生成质量非劣或产品效果。检索命中可能对答案生成有帮助，但不是答案正确率、官方分类 F1、拒答正确性或 LLM judge。

## 导出给独立 reader

[retrieval_export.py](scripts/retrieval_export.py) 从 run + 原始 corpus/query 重构已经验证的真实 context，核对配置/输入/上下文 hash 和字节数。必须显式选方法、split、limit；`--limit 0` 为全部合格题，正整数为原问题顺序的前 N 题，不能把这种便利子集称为随机或分类均衡样本。缺失/失败的检索会阻止导出，不静默删除该题。

```sh
python benchmarks/memory/scripts/retrieval_export.py \
  --run benchmarks/memory/reports/locomo-bytes8192-run1 \
  --corpora benchmarks/memory/prepared/locomo/corpora.jsonl \
  --queries benchmarks/memory/prepared/locomo/queries.jsonl \
  --method bm25_raw --split dev --limit 8 \
  --output benchmarks/memory/reports/locomo-bm25-reader-dev8.jsonl
```

输出每行严格只有 `{id,query,context}`，适配 [glm_adapter.py](scripts/glm_adapter.py) 的输入合同；关联 `.jsonl.manifest.json` 记录选择、配置与 trace/output 哈希。gold、category、答案和 evidence 不进入 reader 输入。query 是原问题文本，目前不额外注入 LongMemEval question date，因此这不是 LongMemEval 的完整官方 reader 协议。

导出器本身不调用模型。GLM 的预算、凭据、执行开关和 dry-run 协议见 [GLM_ADAPTER.md](GLM_ADAPTER.md)。后续真实模型比较必须保持四方法相同题目、reader 配置与生成预算，并由独立官方 scorer/明确的新评分协议评答案；不能把这里的 evidence 指标替代生成评分。

## 回归验证

```sh
python -m unittest discover -s benchmarks/memory/tests -p 'test_retrieval_*.py' -v
python -m py_compile benchmarks/memory/scripts/retrieval_*.py benchmarks/memory/tests/test_retrieval_*.py
```

18 项原创合成测试覆盖 gold 不被打开、注入字段拒绝、重复 ID、空语料/空词项、Unicode 精确边界、整块跳过、稳定同分排序/拆分、非计时结果重现、输出拒绝覆盖、异常 evidence、错误/缺失结果保留分母、输入/trace 篡改拒绝，以及导出的严格 reader 字段合同。测试不下载数据、不使用真实用户内容、不调用模型。
