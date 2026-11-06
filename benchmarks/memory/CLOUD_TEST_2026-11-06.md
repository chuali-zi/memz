# 新 memz 云环境实测进展（2026-11-06）

## 主要结果

真实模型调用 **0 次，真实基准样本 0 题**。不能给出 memz 相比无记忆或完整上下文的质量、token、延迟或费用优势。当前执行进程没有检查到六个合理的 GLM 凭据别名，Library 数据传递也未成功；用户已经明确授权使用智谱官方 API，实际账户产品／计费类型尚未验证。已完成安全修复、调用前 token／费用预约逻辑和 **61 项离线合成回归**，不是模型性能实验。

本次只使用任务选定的新云环境 `ccarenv_b64_Y2NhcmVudl81NjI0NGIyMDZjMWM4MTkxOWRiZjFjOWYzNWZkNTkyZA`，工作区 `/workspace/memz`。实际分支为 `work`；开始时 HEAD 和只读查询的远端 `origin/main` 均为 `dd31a8733cf4f445c57d80896b3d855ca14bfa5f`，远端为 `github.com/chuali-zi/memz.git`。未换旧环境或本地电脑。工作区、仓库及其父目录未发现 AGENTS.md，checkout 没有 `.agents/skills/*/SKILL.md`。读取了 README、公平评估协议、GLM 适配器、离线检索说明和 CI 测试约定。

## 阻碍与状态

| 操作／目标 | 核实结果和原因 | 已完成部分 | 状态 |
| --- | --- | --- | --- |
| 读取环境注入的模型凭据 | `GLM_API_KEY`、`GLM_KEY`、`ZHIPU_API_KEY`、`ZHIPUAI_API_KEY`、`ZAI_API_KEY`、`MEMZ_GLM_API_KEY` 均 absent；用户更新信息后再次限定检查 `GLM_API_KEY`，仍 absent | 只记录存在性，未读取、打印或保存任何密钥值；没有发认证探测。不能据此说用户没有配置保险库 | pending：运行进程没有收到检查的变量；配置请求／作用域／发布状态 unknown |
| 取得 `memz-benchmark-prep-2026-11-05.tar.gz` | 当前 Library 官方下载流程报 `library download request failed: hosted apps tools/list request failed: network`；初次及一次明确指向消费端目录的有界重试均失败 | 精确文件名搜索已确认 ID、名称、大小；两个目标路径均不存在 | pending：技术传递失败，不是自动审批 denied，也没有不确定的后台下载 |
| 数据包哈希／安全解压 | 没有可读字节，不能计算哈希、列包或解压 | 保留预期 SHA256 与文件身份 | pending：未把历史哈希冒充本次核验 |
| 小规模真实配对测试 | 凭据、数据未就绪；具体模型、可核实价格、tokenizer 和费用上限配置尚未锁定 | 查清现有 adapter／baseline 与协议边界 | pending：未发送付费请求 |
| memz 原始历史→回答主实验 | 当前产品依赖候选审批；现有 LoCoMo 离线 BM25 不是 memz adapter | 保留协议，不导入 gold，不自动批准原文为事实 | pending：需要题目无关的抽取／审批与隔离 scope adapter |
| 官方 API 授权与账户计量 | 用户最新明确授权使用智谱官方 API；实际 key 产品、费用／积分口径 unknown | 支持 `GLM_API_KEY` 回退别名，不依据变量名推断账户类型，不另设套餐推断阻碍；官方 endpoint 保持不变 | authorized；技术上仍等待变量可见和安全有界运行条件，没有尝试调用、购买余额或改权限 |

Library 身份：`libfile_415877126b3c8191b27748345dcdd65f`，`file_00000000ee1c81f5bdf46ffd1a57c4ca`，大小 9,432,465 bytes。历史预期 SHA256：`8b3d80c158e1f52f91bef0ac40a88f701963ca050cb2ea3f44debfc779e772d5`，**本次未验证**。下载目标是 `/workspace/memz-library-input/` 和 `/workspace/memz-library-input-retry/`；没有取得可读文件。后续检查确认 Library 的报告读取／保存服务正常；当前官方三个传递组件与上次逐字节相同，没有公开的受支持连接健康检查入口，也没有恢复证据，因此未进行第三次下载。工具服务可用不证明容器下载连接恢复。没有访问 Hugging Face、猜测存储 URL、改用其他下载接口或环境。没有尝试 push、合并或部署，没有自动审批拒绝事件。

运行时 `CODEX_ENVIRONMENT_ID` 与本任务环境 ID 一致；可见运行时目录未提供配置版本或 secret 作用域。父任务提供的新配置 ID 为 `79fb5ea2-df51-45df-b514-31e9aaaf194e~asenvcfg_de420200590481919b1c30fb826a948e`，version_id 为 `38d80616-7934-4857-a2db-25d7b6111694~cecfgver_6aed809dbcd0819e8e891a41f1a4680c`；这两个值是父任务核实信息，**本容器不能独立确认该版本绑定，记 unknown**。不读取私有凭据文件、setup 秘密日志，也不从 setup 复制秘密以延长作用域。

平台网络秘密以进程占位符和代理替换交付，属于正常支持方式；Personal vault 需要 Key 与环境请求同名、Applies to 覆盖该环境。环境设置改动需 Republish，新任务继承更新，已有任务保留自身状态。这些是平台文档事实，不证明此用户已经或尚未正确配置。[平台文档](https://learn.chatgpt.com/docs/environments/cloud-environments)

用户最新确认可以使用其 key 调用智谱官方 API。本任务遵循此授权；不再将未核实的账户／套餐适用性解释为独立阻碍，也不根据变量名假定余额、套餐或计费方式。代码支持 `MEMZ_GLM_API_KEY` → `ZHIPUAI_API_KEY` → `GLM_API_KEY` 的确定回退顺序。目的地仍固定为智谱官方 `https://open.bigmodel.cn/api/paas/v4/chat/completions`，不以改端点或伪装工具绕过服务拒绝。若服务实际拒绝，保留脱敏 HTTP 状态并停止。最新再次存在性检查中六个别名仍均不可见，认证与推理调用均为 0。

## 代码与验证

修复 `scripts/glm_adapter.py`：

- 在成功响应进入结果对象前检查实际发送凭据的字面／JSON 转义回显；检测后丢弃响应、固定错误码并停止，不再写出可能含凭据的答案或元数据。任意编码／变换的秘密不在该检测承诺内。
- CLI 结果文件以 `0600` 原子独占创建，即使 umask 宽松也不开放给其他用户；继续拒绝覆盖与已有符号链接。
- 添加可选 `strict_usage=true`；缺失或不一致的 prompt/completion/total 计量使本行失败并停止后续请求，保留安全回执与完整失败分母。
- 保留 provider 返回的请求 ID、fingerprint、缓存和推理 token；缺失保持 null，拒绝布尔值、负数及大于对应总量的明细。仍只按显式 flat prices 估算，不能推断缓存折扣或账单。

先运行现有 **46/46** 离线测试通过。新增 5 项安全／计量测试在修改实现前失败，修改后 **51/51** 通过；后续增加 9 项预约预算测试和 1 项用户别名／代理占位符测试，整个 memory suite **61/61** 通过。`py_compile` 和 `git diff --check` 通过。没有修改数据库、服务端或 UI，所以没有启动 PostgreSQL，也没有运行会写数据库的整套系统/UI 测试。

后续实现 `spend_guard`：由可信的完整 chat tokenizer 计数，调用前检查单次／累计输入 token，使用 Decimal 预约输入费用和最大输出费用，超限在读取凭据及传输前停止；短回答、失败或超时不退还预约。计数器缺失或身份不匹配则 fail closed；provider usage 缺失／不一致，或实际输入超过预约，保留安全回执后停止。CLI 的 `--execute` 现在必须启用 guard；因为尚无核实过的生产 GLM tokenizer，CLI 不会真实调用。Python 接口保留无 guard 的旧合成测试入口；付费实验必须显式启用 guard。

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

最小后续操作：只核对现有保险库 `GLM_API_KEY` 是否已保存、环境是否请求同名 Key、Applies to 是否包含这个新 memz 环境；不需要再次发送秘密，也不要求改变 secret 类型或购买余额。如果确实改了环境配置，按平台流程保存／Republish 后在同一新配置发起后续任务；本任务不重建环境。容器无法查看这些设置，因此不能断言哪一项配置错了，也不能保证仅等待服务恢复就能让变量出现。没有依据要求重配全部环境。下载故障需要受支持的连接／服务恢复，当前没有需要用户重新上传数据的证据。

取得包后核对上面的哈希，拒绝绝对路径、`..`、软／硬链接和设备条目，限定文件数与展开大小，独立解压，只导入核验后的数据，不覆盖当前代码。LoCoMo 原始数据应再核对 manifest 中 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`。

没有数据，尚不能生成真实选样 ID 清单或数据哈希。恢复后用 seed=42 固定选样与配对组顺序，先少量 smoke，再最多约 20 道配对题；选样和各组输入在调用前哈希封存。固定同一 reader、问题、提示、输出上限与总输入预算；完整上下文若溢出应报告并另用 recency 预算基线。模型与单价必须按已配置、可核实的低成本模型确定，先计算最坏输入、输出、请求数和费用预约上限；未锁定这些条件前继续保持 0 次执行。

现在预约停止器已经实现并通过合成测试，但**尚无核实过的生产模型 tokenizer、价格与具体运行上限**。不会用字符或字节伪装准确 token。计数器 ID 匹配不是正确性证明，仍需验证其完整聊天模板；配置价格、provider routing 或隐藏计费项改变会使费用预约估算失效，不能声称它是 provider 账单硬上限。不能将该改进称为已能完整实测的 runner。

memz adapter 的安全实现边界：在看到问题前，按独立 scope 导入历史为来源，抽取器只能生成候选；负责人审阅通过后冻结事实／版本／来源映射及 hash。所有方法使用同一 reader、同一选题和输出预算；`flat_same_facts` 得到同一已审事实包，`memz_current` 通过真实只读 context 路径获取版本和溯源，并记录认证／检索／构建／回答的完整 span。当前没有批准协议、已审事实包和输入数据，不能自动批准或把原始 turn 冒充已批准事实，故本轮只确定边界，不创建会偷用 gold 的假 adapter。应记录首次建库／审批开销、缓存明细、逐题完整端到端 span 和实际 Q；质量由独立 evaluator 计算，检索覆盖不能当作答对率。
