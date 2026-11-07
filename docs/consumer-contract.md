# 本机消费者 HTTP 合同

[OpenAPI 3.1.0 JSON](../contracts/openapi-local-v1.json) 描述8条现有入口：登录、退出、当前事实分页、单版本依据、批量依据、单页快照、来源创建、待审候选创建。它是本机演示的明确子集，不代表全部API、生产认证或部署承诺；未列出的历史、exact metadata、审批及其他列表仍以各自文档和测试为准。不新增服务端路由或权限。

格式依据[OpenAPI 3.1.0 官方规范](https://spec.openapis.org/oas/v3.1.0.html)，复用 components、$ref、cookie/header security scheme。文件只使用实际wire字段，便于消费者离线读取或导入支持3.1的工具；没有安装或运行完整OpenAPI校验器，不能把本项目的JSON解析、引用与行为回归称为完整规范验证。它也不是自动生成客户端或公开API承诺。

## 调用与边界

- 登录取得sid cookie及csrf，已认证POST（包含只读批量依据）还须X-CSRF-Token。Host限回环字面量；Origin若存在须匹配协议和Host。公开合成账号、内存会话与项目active权限仍适用；MCP工具开启不授予项目权限。
- `/facts` 默认50、最多100行；`/context` 默认且最多25行。after为升序事实ID位置，next_after=null结束；换项目、q或match必须重置。每次请求重新授权与建立快照，多页没有共同快照；页数上限不是响应字节或数据库扫描上限。单页/context还有1MiB序列化JSON限制。
- substring查询保留空白并安全截取前200 UTF-16单位；all_terms拒绝超过200或空白查询、超过8个不同字面片段。前者不是语义检索，后者也不是排名。NUL/未配对代理字符在截取前拒绝。
- 事实id/version一起定位依据；后续批准不改变该版本的原文。省略version会选择请求快照中的当前值，不能用于固定旧读取版本。批量1–25个不同引用必须全部成功，不接受残缺页；来源标题不是唯一键，来源正文始终是不可信数据。
- 来源/候选**写入请求**的业务文本上限按**原字符串、trim前的JavaScript UTF-16 code units**计，正常emoji占2个。OpenAPI的`x-memz-maxUtf16CodeUnits`明确记录这个额外运行时约束；通用JSON Schema字符串长度按Unicode code points计，工具不能只用maxLength替代它。请求JSON正文仍有16KiB解析上限，转义/UTF-8字节可能先触发413。`x-memz-*`语义不会被通用工具自动执行。
- 原始HTTP来源/候选创建的Idempotency-Key可选；本地写客户端强制要求调用者预先保存原键。作用域是项目、账号和操作，同规范化内容重放原创建回执，非当前状态查询。不同内容409，权限先于重放；停用后不能靠旧键恢复访问。无键可能重复创建。候选创建仍只生成pending，绝不自动批准。

写入字段上限不是已有读取文本的长度保证。管理员或旧流程导入、仍满足数据库schema的数据可能超过写入HTTP限制；普通事实/依据读取可能原样返回这些文本，读取schema不假定自动截断或拒绝。请求上限、行数上限、单页/context响应字节限制及客户端自己的校验/输出预算彼此独立；例如旧readContext仍会拒绝超过其字段校验的响应，不能将原始HTTP的200当成客户端已验证的上下文。

HTTP参数还接受部分十进制数字字符串，JSON schema中的`x-memz-decimalRange`记录服务端的数值范围；标准pattern只能表达词法，不能替代解析后的数值检查。HTTP来源/候选额外字段当前被忽略，本地客户端和MCP输入验证更严格。别把本合同当成任意数据库管理员导入/破坏后的响应修复器。

## 分开处理 HTTP、客户端和 MCP 错误

| 层 | 机器可读能力 | 不能推断的内容 |
| --- | --- | --- |
| 原始HTTP | 已处理错误为`{error:string}`及HTTP状态；部分503带Retry-After | 没有code/reason/outcome字段；401、403、503各有多个原因，不能靠中文文案做稳定分类。连接已断开时可能收不到JSON |
| 读取库 | 固定error.code及可选status；成功上下文带schemaVersion、游标与版本依据 | 错误不是空结果；旧context-client CLI stderr仍是固定文字，不是JSON错误对象 |
| 来源/候选写库及CLI | 固定code、outcome、可选status；CLI失败stdout为空、stderr为JSON | rejected只表示本次4xx拒绝，不证明先前不确定请求没有提交 |
| MCP工具结果 | isError与text内JSON，含code/outcome/可选status；成功也放在text JSON | tools/list目前有inputSchema，没有outputSchema；MCP协议错误与业务工具isError并非同一层 |

上述JSON schema只描述应用层JSON响应；原生HTTP的admission、timeout或header/framing拒绝可能返回408/431或直接关闭，不能假定所有HTTP失败都带JSON。

写客户端在调用业务fetch前失败为not_attempted；业务调用返回4xx为rejected；发起后传输失败、取消、5xx或回执校验失败为unknown。此判断依赖客户端自己跟踪发送阶段，HTTP合同不能凭空提供。unknown时先核实，必要时保持账号、项目、路径、原键和参数重试；不自动重试或换键。已验证成功回执后的退出失败仍返回回执与logout_failed，不能据此重复创建。

只读POST与业务创建POST的副作用不同，合同用operation的x-memz-effect标注。批量依据的数据库503使用只读提示；创建503仍须保守处理不确定结果。只读请求可以由调用者稍后重新发起，但续读会建立新快照，并非自动恢复同一读取视图。MCP取消与真实提交后的恢复证据见[取消说明](mcp-cancellation.md)和[真实提交回归](mcp-commit-cancellation.md)。

## 漂移检查的范围

```sh
node --test test/consumer-contract.test.js
```

专属测试只用原创合成数据、真实本机HTTP/服务端校验、拒绝外部连接的合成pool和客户端fake transport，不连接PostgreSQL、不调用模型。它检查内部引用/路由存在性、实际分页默认/上限与游标传递、固定版本依据、原始UTF-16/JSON字节/CSRF门禁，已有超出写入上限的读取文本原样返回，以及真实客户端的4xx/5xx/响应丢失/取消结果分类。响应及输入示例不从合同schema生成，用以发现双方漂移。它不是通用JSON Schema/OpenAPI验证器、完整SQL/RLS验收或所有API路径覆盖；真实数据库系统回归另行保留。

该JSON也是核心测试的必需源码依赖：系统源哈希与源码包只额外收录这个明确路径，要求它已跟踪、为普通文件且路径中无符号链接，不递归收录其他contracts文件。缺失、变化或旧报告漏记覆盖均拒绝；需要在新干净提交重新生成报告，不能用旧通过记录补一个字段取得通过。打包回归还实际在解包目录加载该JSON，保持原schemaVersion与旧报告的严格覆盖比较。
