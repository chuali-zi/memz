# 显式开启 MCP 已批准历史读取

`memz_read_history_context` 将已有历史 HTTP/CLI reader 暴露为可选的本机 stdio MCP 工具。它读取已批准修订（包括被后续版本替代的旧值）及完整来源；不调用模型、不提取事实、不创建候选、不审批，也不自动选择历史视图。旧合成 DeepSeek 实验说明了当前事实视图的能力边界，不是本功能的新质量实测。

默认关闭。操作者在 MCP 进程环境显式设置 `MEMZ_MCP_ENABLE_HISTORY_CONTEXT="1"` 才可发现和调用；只接受 `"0"`、`"1"` 或未设置。开启后追加在原工具清单末尾，原 `memz_read_context`、可选 proposal、可选 label 的顺序不变；未开启的历史工具返回 `UNKNOWN_TOOL`，不会先发 HTTP 请求。

## 可审阅的宿主配置

```sh
node scripts/mcp-config.js --host claude-desktop --history-context
node scripts/mcp-config.js --host vscode --label-context --history-context
```

生成器仍固定公开合成 viewer、项目 1、回环地址和 proposals=`"0"`，仅输出可审阅 JSON，不读写宿主配置。新增模块选项为 own boolean data property `historyContext`。只有 `true` / `--history-context` 追加 `MEMZ_MCP_ENABLE_HISTORY_CONTEXT="1"`；省略或 `false` 的默认 JSON **逐字节保持旧输出**，不会新增历史开关的 `"0"` 字段，label 旧行为也保持。生成器不读取、覆盖或清理宿主自行继承的环境；若宿主另外设置了历史开关，应由操作者移除或设为 `"0"`。

工具使用进程配置中固定的项目、地址和账号。生成配置默认 viewer；操作者自行改用其他已授权演示账号不会改变 HTTP 服务的角色检查。调用参数无法替换身份或项目，开关本身不授予权限，不引入生产认证。

## 参数与回执

```json
{"name":"memz_read_history_context","arguments":{"limit":5,"maxOutputBytes":32768}}
```

只接受以下三个可选字段，`additionalProperties:false`：

| 字段 | 合同 |
| --- | --- |
| `limit` | 整数 1–25，MCP 默认 10；原 module/CLI 默认 25 保持不变 |
| `before` | 正整数修订游标，最多 2147483647；省略表示首页，显式 `null` 拒绝 |
| `maxOutputBytes` | 整数 2048–32768，默认 32768；完整 JSON 的 UTF-8 字节预算，不是 token |

没有 `question`、`date`、`asOf`、query、selector、身份、URL、超时、证据注入或 signal 参数。错误参数在发 HTTP 前拒绝。原环境变量 CLI 不新增 stdin 协议；`--stdin`、`--signal` 和其他 argv 仅返回固定 `INVALID_ARGUMENTS`。可选 native `AbortSignal` 仅属于模块接口和 MCP SDK 的本次调用上下文。

成功返回原 `memz-history-reader-v1` JSON，保留 `projectId/before/limit`、`revisions`、去重后的完整 `sources`、`sourceTextIsUntrusted`、`consistency`、`truncated/nextBefore`。`revisions[].id` 是事实 ID，`revisionId` 是修订 ID；续读应原样使用 `nextBefore`，不能使用事实 ID 代替。空页明确返回空数组和空游标，不发明旧值或证据。

一个非空页依次执行真实登录、history GET、固定 factId/version 的 batch provenance 只读 POST、注销；空页省略 provenance。只读 POST 仍执行 CSRF 检查。来源以完整原文返回，指令样式的文本仍是不可信数据；MCP 注解不替代宿主授权、内容隔离或防提示注入措施。

预算包含完整回执及来源，转义和 Unicode 也按实际 UTF-8 JSON 字节计数。不能容纳时整次返回 `OUTPUT_BUDGET_TOO_SMALL / read_failed`，不截断原文、不删除修订、不回退当前事实或自动续页。可由调用者明确降低 limit 后重读。原单 HTTP 响应 1 MiB 和 MCP 256 KiB 全局发送保护保留。

## 审批、时间、快照与取消

只返回已批准修订，排除待审批和已驳回候选。页读取与 provenance 读取来自独立事务；固定旧版本的依据不会默默换成新批准版本，但完成时不保证仍最新。两阶段间撤权会使整次读取失败，不返回已取得的部分页。续读建立新视图，多个页不是整个项目的共同快照。

修订顺序不等于任意业务日期的生效语义。现有历史投影没有业务生效时间，不提供任意日期 as-of 查询，也不会根据自然语言日期自动选择版本。

历史模块复用已有 `withReadSession`。原请求期限和读取总期限保持，外部取消会中止真实登录/读取连接及响应正文；不是只停止等待的 Promise.race。已知会话仍尝试在独立的最多五秒期限内注销，保留先前主错误；取消若在注销期间到达，也不会返回已读取的数据。一次业务调用期间其他工具继续返回 `BUSY / not_attempted`，清理完成后释放锁。

登录尚未完整确认时，服务端可能已经创建了未知会话，客户端不保证能够注销它。宿主取消或断连后可能收不到工具响应；HTTP 取消不等于 SQL 已回滚或会话必被撤销。强杀进程也不保证执行清理。不自动重试或改用更高权限账号。

## 验证

```sh
node --test test/history-context.test.js test/mcp-history-context.test.js test/mcp-config-history-context.test.js
MIGRATION_TEST_DATABASE_URL=明确的专用测试管理员连接 node --test test/mcp-history-context-postgres.test.js
```

纯测试及真实回环 HTTP/官方 SDK/stdio 检查开关八组合、默认 JSON 兼容、两种宿主生成配置、参数隔离、完整来源、字节边界、错误恢复、BUSY、预取消、登录未知会话、history/proof 正文取消、断连、主错误和独立注销。独立 PostgreSQL 用随机临时库和明确的合成 owner 决策，验证旧版本与未批/驳回隔离、跨项目权限、撤权、并发批准、固定修订、预算、实际 HTTP 取消及业务表指纹不变，并删除本次数据库。

这些是合成工程功能回归，没有外部模型请求或新的回答准确率、token、速度、费用结果；未安装或改动真实宿主设置。
