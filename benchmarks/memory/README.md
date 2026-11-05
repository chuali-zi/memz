# 长期记忆 benchmark 准备

为后续验证 memz 是否降低延迟、减少 token 且保持任务质量准备的研究、清单和离线脚本。本目录没有真实模型效果、加速或节省结果；不改变 memz 功能，也不自动审批候选。

完整方法研究见 [RESEARCH.md](RESEARCH.md)，公平实验协议见 [EVALUATION_PLAN.md](EVALUATION_PLAN.md)，原准备环境的实际验证和限制见 [VERIFICATION.md](VERIFICATION.md)。

## 分发范围与许可

仓库只包含本项目编写的说明、适配/校验脚本、来源元数据和空白结果表。**不包含数据集、规范化语料、逐题输出、第三方源码、模型、缓存或压缩包。** `data/`、`sources/`、`prepared/`、`reports/` 和下载/打包产物均被忽略。

- [sources.lock.json](sources.lock.json)：OpenViking、LongMemEval、LoCoMo、MemoryAgentBench、LongMemEval-V2 的官方地址、精确 commit、许可证和调研范围，仅引用源码。
- [manifest.lock.json](manifest.lock.json)：数据官方来源、固定 revision、已知字节数、SHA256 和访问条件。未知字段为 null；不把引用条目当成已下载。
- OpenViking 核心为 **AGPL-3.0**，LoCoMo 仓库/数据为 **CC BY-NC 4.0**；不要视为宽松商业许可，也不要直接把第三方实现合入 memz。LongMemEval/MAB 的代码和数据卡为 MIT，V2 为 Apache-2.0；派生数据仍需保留原始来源条件。
- 公开基准的 gold 只属于 evaluator。生成文件名 `gold.private.jsonl` 表示流程隔离，不表示其中含真实用户私有数据；本任务没有使用真实用户数据。

## 已验证与未完成

2026-11-05 的独立准备环境已用官方 LoCoMo 10 对话版本验证：2,805,274 字节，SHA256 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`；5,882 turn、1,986 题。8 题 smoke 和全题离线检索通路完成；规范化可逐字节重现，注入答案字段的查询被检索器拒绝。发现 9 个原始 evidence 引用无法直接匹配 turn ID，保留标签，不静默修复。

LongMemEval S/oracle/M、MAB parquet/entity2id 和 V2 数据在该环境均未取得；Hugging Face 的官方 oracle HEAD 预检被受管云网络政策拒绝（CONNECT 403）。没有重试、改变代理或绕过限制。这里不分发已取得的 LoCoMo 文件；新 checkout 应通过官方来源获取或从有授权的本地副本导入后校验。本次整理和推送没有恢复任何数据下载。

当前 memz 基线仍是需要审批的结构化事实演示，使用整段子串检索，尚无自动抽取/摘要或模型接入。因此真实实验还需要独立的历史→候选→审批→检索 adapter。下述脚本是离线加载/通路准备，不是 memz 的完整模型 benchmark。

## 目录与运行条件

Python 3.10+；LoCoMo/LongMemEval 离线适配只需标准库。MAB parquet 加载另需 `pyarrow`。Node、PostgreSQL 或付费模型不参与这里的离线 smoke。

从仓库根目录进入本目录：

```sh
cd benchmarks/memory
python scripts/acquire.py
```

默认只检查本地文件，绝不下载；缺失/未验证条目使退出码为 2。报告写到被忽略的 `reports/acquisition-status.json`。

若已有官方 LoCoMo 文件，放到 `data/locomo/locomo10.json` 后运行：

```sh
python scripts/acquire.py --only locomo
python scripts/prepare.py --dataset locomo \
  --input data/locomo/locomo10.json --output prepared/locomo
python scripts/offline_smoke.py --prepared prepared/locomo \
  --limit 8 --top-k 8 --output reports/locomo-smoke-8.jsonl
python scripts/offline_smoke.py --prepared prepared/locomo \
  --limit 0 --top-k 8 --output reports/locomo-offline-all.jsonl
python scripts/validate_offline.py
```

输出目录/文件必须是新路径；脚本拒绝覆盖现有准备结果。重复时使用 `prepared/locomo-replay` 和新报告名，并用 validator 的 `--prepared`、`--trace`、`--output` 指定路径。`--limit 0` 为全部题目。

`prepare.py` 将 `corpora.jsonl`、`queries.jsonl`、`gold.private.jsonl` 分开；检索进程不读取 gold。BM25 是本目录简单词法 smoke，不是官方 BM25 的精确复现，不生成答案，不计算模型 token 或 memz 性能。

独立合成回归，不需要下载数据：

```sh
python -m unittest discover -s tests -p 'test_*.py' -v
python -m py_compile scripts/*.py tests/*.py
```

## 将来补齐公开材料

**以下下载/模型命令未在本次仓库整理中执行。** 先检查许可、磁盘/内存与当前网络政策。受管云须用支持的配置流程放行官方域及实际存储重定向域；遇 403 或访问门槛停止该项，不更换代理或绕过。普通机器没有受管 policy 文件时，显式增加 `--allow-unmanaged-network` 才允许下载；该参数不能覆盖存在的受管政策。

```sh
# LoCoMo；其他已固定数据按 ID 选择，预期校验成功才原子改名
python scripts/acquire.py --download --only locomo
# S + oracle + 四个 MAB parquet 约 367.6 MB
python scripts/acquire.py --download --only lme-oracle lme-s mab-ar mab-cr mab-lru mab-ttl
```

脚本不覆盖现有 `.part`，不自动重试；没有预期 SHA256 的 entity2id 不自动下载。优先导入已有合法副本以免重复下载：将副本按 manifest 相对路径组织到 `TRANSFER_ROOT`，运行 `python scripts/acquire.py --import-root TRANSFER_ROOT --only lme-s`；只复制长度和预期 hash 相符的文件。

```sh
python scripts/prepare.py --dataset longmemeval \
  --input data/longmemeval-cleaned/longmemeval_s_cleaned.json --output prepared/lme-s
python -m venv .venv-data
.venv-data/bin/pip install pyarrow
.venv-data/bin/pip freeze > reports/data-environment.freeze.txt
.venv-data/bin/python scripts/prepare.py --dataset mab \
  --input data/MemoryAgentBench/data/Conflict_Resolution-00000-of-00001.parquet \
  --source factconsolidation_sh_6k --output prepared/mab-cr-6k
```

LongMemEval/MAB 的真实文件加载没有在原云环境运行。MAB 只是格式 loader，官方模板、chunking 与 source-specific 辅助输入仍需适配。M 为额外 2,737,100,077 字节，标准 JSON 全量解析需更多 RAM；V2 计划原始总量约 7.12 GB，截图解压容量另计，均延后处理。

若要检查/运行官方评测，在被忽略的 `sources/` 下获取对应官方仓库，按 `sources.lock.json` 的 **精确 commit** checkout；例如：

```sh
git clone --filter=blob:none --no-checkout https://github.com/volcengine/OpenViking.git sources/OpenViking
git -C sources/OpenViking checkout 739e17f9172b9f595bfe4cc95293ec52d4686120
git clone --filter=blob:none --no-checkout https://github.com/xiaowu0162/LongMemEval.git sources/LongMemEval
git -C sources/LongMemEval checkout 9e0b455f4ef0e2ab8f2e582289761153549043fc
```

官方评测依赖和模型配置需另行准备。OpenViking RAG 的默认 `all`/`del` 会删除资源根，不在共享实例上运行。正式模型比较必须先获得对应授权、固定模型及计量配置；本次付费模型调用为零。
