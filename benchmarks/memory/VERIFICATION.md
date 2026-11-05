# 准备验证记录与适用范围

2026-11-05；memz 被研究的基线为 `bc8cc55c3a0849dcce0752854b60eec75711d0c5`。本目录的改动只涉及 benchmark 准备，没有运行模型或改变应用行为。

## 原始准备环境已完成

- 官方 LoCoMo JSON：2,805,274 字节，SHA256 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`。
- 规范化：10 conversation、5,882 turn、1,986 question；category 1/2/3/4/5 分别 282/321/96/841/446，categories 1–4 合计 1,540。
- 8 题 smoke 和全 1,986 题本地 BM25 检索通路完成。查询 ID 不重复、query/gold ID 一一对应、返回文档 ID 不跨 scope；没有模型答案/质量分/模型 token。
- 新目录下重复规范化得到逐字节相同的三个文件；人工注入答案字段的 query 被检索器拒绝，未输出检索结果。
- 9 个官方 evidence 引用无法直接匹配 turn ID（含复合字段、残缺或缺失 ID），保留原数据，不自动修复；未来 evidence recall 需要预注册解析和分母。
- 五个官方代码版本与当前清单一致；原本地源码/数据/交接档案未随 Git 提交。

## 仓库可重复的验证

整理进仓库后，6 项标准库合成回归和 Python 语法检查通过；使用原有且 hash 匹配的公开 LoCoMo 本地副本重新执行新脚本的规范化、8 题 smoke、1,986 题检索及完整性校验，计数和 9 个 evidence 引用异常与原结果一致。运行产物均在仓库外临时目录，没有重复下载。UTF-8 输入/输出显式指定，避免普通 Windows locale 改变语料编码。

`tests/test_offline.py` 只使用本项目自写合成内容，覆盖 gold 隔离、不同 scope 中相同文档 ID 的隔离、图片 caption 保留/URL 不导入、注入答案拒绝、重复 ID 拒绝、缺失文件失败、LongMemEval 标签剥离和答案类型、受管政策拒绝不被普通主机参数覆盖。它不调用网络或模型，不依赖第三方数据许可证。

```sh
cd benchmarks/memory
python -m unittest discover -s tests -p 'test_*.py' -v
python -m py_compile scripts/*.py tests/*.py
```

若另行取得已校验的官方 LoCoMo，README 的 prepare/smoke/validate 命令复现真实数据通路。实际数据、gold、逐题 traces 和 validation 输出属于本地运行产物，被 `.gitignore` 排除，不提交到 Git。

## 未运行与确切限制

- LongMemEval S/oracle/M、MemoryAgentBench、V2 的真实数据加载仍未验证。原云环境访问官方 HF oracle 地址的 HEAD 返回 CONNECT 403；本次仓库整理没有恢复下载、重试或绕过政策。
- MAB 的 parquet 格式 loader 没有执行真实数据，也不代表官方任务模板/分块/辅助输入已接好；entity2id 的精确 size/hash 尚未固定。
- 未配置或运行正式 reader、judge、embedding、rerank。付费模型调用为零。
- 未启动 PostgreSQL、memz 或 OpenViking。没有运行本地数据库/UI/查询计划集成测试，因为应用实现与数据库未变；仓库现有 GitHub CI 应在推送后针对精确提交独立确认。
- 当前没有 memz 原始历史→事实提取→审批→回答的实验 adapter，因此没有可发布的 memz 质量、延迟或 token 收益数据。实验配置中的 null 是待配置项，不是默认已验证值。
