# MCP 取消与写入结果边界

`memz_submit_proposal` 使用官方 SDK 为本次调用提供的取消信号。登录及候选请求的真实 HTTP 连接、响应正文读取同时受取消和原有请求期限约束；没有通过只停止等待的 `Promise.race` 留下后台写入。

写入请求发送前检查到取消时，不再发送候选 POST。模块调用返回固定 `REQUEST_CANCELLED` / `not_attempted`；发送过写入请求之后再取消时返回 `REQUEST_CANCELLED` / `unknown`，服务端可能已经提交。两者均不自动重试。宿主应在首次调用前保存完整意图及幂等键，结果不确定时先核实，重试复用相同键和参数，不能推断已经回滚。MCP 宿主取消或断开后可能收不到工具响应，因此不能依据“没有回执”判断未发送。

`submitProposal`、`createSource` 的模块接口支持可选 `AbortSignal`；信号不属于 CLI stdin 或 MCP 工具参数，调用者不能通过参数改变项目、账号或取消策略。未传信号的 CLI 行为及成功回执结构保持兼容。已取得有效会话时仍尝试注销，注销使用独立的最多五秒期限，返回 401 的未完成正文会主动取消；注销失败仍沿用既有清理结果规则。若登录响应尚未完成就被中断，本地可能尚未取得注销所需的会话及 CSRF，不能保证撤销服务端已创建的会话。

`memz_read_context` 和显式开启的 `memz_read_label_context` 也向读取模块传递本次 SDK 取消信号，登录、读取和响应正文会实际中止；已经取得会话后仍尝试在既有期限内注销。外部取消信号不属于 CLI stdin 或 MCP 工具参数。无论读写，进程被强制杀死都不保证完成清理，也不能撤销服务端事务。读取取消和断连回归见[字段问句读取](mcp-label-context.md)。

`node --test test/write-cancellation.test.js` 使用真实官方 SDK、stdio 子进程和回环 HTTP 合成服务，验证预取消零请求、登录阶段取消零候选请求、已完成登录后取消仅注销、写入响应正文中断的 `unknown`、稳定意图与幂等键、MCP 取消/断连后的单次已接受请求及注销，以及 401 无止正文的连接释放。测试不连接数据库、不调用模型；真实数据库提交后重放仍由 `test/mcp-recovery.js` 的隔离系统测试覆盖。

真实 PostgreSQL 提交后再由 SDK 取消、同键重放及独立运行命令见 [提交后取消集成回归](mcp-commit-cancellation.md)。
