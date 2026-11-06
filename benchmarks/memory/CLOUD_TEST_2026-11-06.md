# 新 memz 云环境实测进展（2026-11-06）

## 主要结果

真实模型调用 **0 次，真实基准样本 0 题**。不能给出 memz 相比无记忆或完整上下文的质量、token、延迟或费用优势。当前执行进程没有适配器支持的凭据变量，Library 数据传递也未成功。已完成安全修复和 **51 项离线合成回归**，不是模型性能实验。

本次只使用任务选定的新云环境 `ccarenv_b64_Y2NhcmVudl81NjI0NGIyMDZjMWM4MTkxOWRiZjFjOWYzNWZkNTkyZA`，工作区 `/workspace/memz`。实际分支为 `work`；开始时 HEAD 和只读查询的远端 `origin/main` 均为 `dd31a8733cf4f445c57d80896b3d855ca14bfa5f`，远端为 `github.com/chuali-zi/memz.git`。未换旧环境或本地电脑。工作区、仓库及其父目录未发现 AGENTS.md，checkout 没有 `.agents/skills/*/SKILL.md`。读取了 README、公平评估协议、GLM 适配器、离线检索说明和 CI 测试约定。

## 阻碍与状态

| 操作／目标 | 核实结果和原因 | 已完成部分 | 状态 |
| --- | --- | --- | --- |
| 读取环境注入的模型凭据 | `MEMZ_GLM_API_KEY`、`ZHIPUAI_API_KEY` 均 absent；不能由“已经在界面配置”推断当前进程已注入 | 只记录存在性，未读取、打印或保存任何密钥值；没有发认证探测 | pending：需要新环境向实际运行进程注入支持的变量 |
| 取得 `memz-benchmark-prep-2026-11-05.tar.gz` | 当前 Library 官方下载流程报 `library download request failed: hosted apps tools/list request failed: network`；初次及一次明确指向消费端目录的有界重试均失败 | 精确文件名搜索已确认 ID、名称、大小；两个目标路径均不存在 | pending：技术传递失败，不是自动审批 denied，也没有不确定的后台下载 |
| 数据包哈希／安全解压 | 没有可读字节，不能计算哈希、列包或解压 | 保留预期 SHA256 与文件身份 | pending：未把历史哈希冒充本次核验 |
| 小规模真实配对测试 | 凭据、数据未就绪；具体模型、可核实价格、tokenizer 和费用上限配置尚未锁定 | 查清现有 adapter／baseline 与协议边界 | pending：未发送付费请求 |
| memz 原始历史→回答主实验 | 当前产品依赖候选审批；现有 LoCoMo 离线 BM25 不是 memz adapter | 保留协议，不导入 gold，不自动批准原文为事实 | pending：需要题目无关的抽取／审批与隔离 scope adapter |

Library 身份：`libfile_415877126b3c8191b27748345dcdd65f`，`file_00000000ee1c81f5bdf46ffd1a57c4ca`，大小 9,432,465 bytes。历史预期 SHA256：`8b3d80c158e1f52f91bef0ac40a88f701963ca050cb2ea3f44debfc779e772d5`，**本次未验证**。下载目标是 `/workspace/memz-library-input/` 和 `/workspace/memz-library-input-retry/`；没有取得可读文件。没有访问 Hugging Face、猜测存储 URL、改用其他下载接口或环境。没有尝试 push、合并或部署，没有自动审批拒绝事件。

## 代码与验证

修复 `scripts/glm_adapter.py`：

- 在成功响应进入结果对象前检查实际发送凭据的字面／JSON 转义回显；检测后丢弃响应、固定错误码并停止，不再写出可能含凭据的答案或元数据。任意编码／变换的秘密不在该检测承诺内。
- CLI 结果文件以 `0600` 原子独占创建，即使 umask 宽松也不开放给其他用户；继续拒绝覆盖与已有符号链接。
- 添加可选 `strict_usage=true`；缺失或不一致的 prompt/completion/total 计量使本行失败并停止后续请求，保留安全回执与完整失败分母。
- 保留 provider 返回的请求 ID、fingerprint、缓存和推理 token；缺失保持 null，拒绝布尔值、负数及大于对应总量的明细。仍只按显式 flat prices 估算，不能推断缓存折扣或账单。

先运行现有 **46/46** 离线测试通过。新增 5 项安全／计量测试在修改实现前失败，修改后整个 memory suite **51/51** 通过；`py_compile` 和 `git diff --check` 通过。没有修改数据库、服务端或 UI，所以没有启动 PostgreSQL，也没有运行会写数据库的整套系统/UI 测试。

复现（从仓库根目录）：

```sh
python3 -m unittest discover -s benchmarks/memory/tests -p 'test_*.py' -v
python3 -m py_compile benchmarks/memory/scripts/*.py benchmarks/memory/tests/*.py
git diff --check
```

## 本次计量边界与后续实验条件

| 项目 | 本次结果 |
| --- | --- |
| 实际 provider/model/snapshot | 无；没有调用 |
| 真实数据样本／配对题／memz 主实验 | 0 / 0 / 0 |
| 模型请求／重试 | 0 / 0 |
| 质量、检索召回、输入／输出 tokens | N/A；没有样本与 usage，不用 0 冒充分数或实测计量 |
| 检索／建库／组装／生成／端到端延迟 | N/A |
| 本任务模型调用费用 | 没有发生模型调用费用；未查询账户账单或余额 |
| 缓存、冷／热、预处理摊销 | 未测；不能假定禁用 provider cache |
| 模型波动与统计结论 | 未测；离线单元测试不提供质量或加速结论 |

下一步先修复新环境的 secret 注入与 Library 消费端连接；不要在聊天里粘贴密钥。取得包后核对上面的哈希，拒绝绝对路径、`..`、软／硬链接和设备条目，限定文件数与展开大小，独立解压，只导入核验后的数据，不覆盖当前代码。LoCoMo 原始数据应再核对 manifest 中 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`。

没有数据，尚不能生成真实选样 ID 清单或数据哈希。恢复后用 seed=42 固定选样与配对组顺序，先少量 smoke，再最多约 20 道配对题；选样和各组输入在调用前哈希封存。固定同一 reader、问题、提示、输出上限与总输入预算；完整上下文若溢出应报告并另用 recency 预算基线。模型与单价必须按已配置、可核实的低成本模型确定，先计算最坏输入、输出、请求数和费用预约上限；未锁定这些条件前继续保持 0 次执行。

现有 adapter 有请求数、输入字节、输出 token、总输出预约和超时限制，**尚不提供模型 tokenizer 的准确输入 token 上限或强制货币预算**。`strict_usage` 是响应后的停止机制，不是付费前的费用保证。真实运行前仍需补齐 tokenizer 与累计费用预约停止器；不能将这次安全修复称为可立即全量跑的 runner。应记录首次建库／审批开销、缓存明细、逐题完整端到端 span 和实际 Q；质量分数由独立 evaluator 计算，检索覆盖不能当作答对率。
