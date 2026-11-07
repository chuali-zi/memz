# MCP 真正提交后取消的集成回归

`test/mcp-commit-cancellation.test.js` 补充“已接受请求不等于已提交”的证据缺口：在随机本机合成 PostgreSQL 库启动真实 server，通过仅回环地址的 HTTP 代理等候候选上游返回200，再用独立直连核实 pending candidate、propose audit 和幂等回执已经提交，facts/revisions未增加。代理暂不向 MCP 放出任何成功响应头或正文；只有核实后才由宿主官方 SDK 的 AbortSignal 取消调用，不在取消阶段强杀 MCP 进程。

随后验证候选 HTTP 确实关闭、使用独立清理期限的真实注销返回200且旧会话变为401、同一个存活 MCP 进程释放 BUSY。原键和原参数重放得到同一 candidate ID，候选/审计/回执仍各一份，数据库候选仍 pending，从未自动审批。宿主取消后不一定接收到工具错误回执，因此此项用独立数据库结果证明已经提交，不把 SDK 的拒绝当作服务端回滚证明。模块及宿主取消语义见 [取消与写入结果边界](mcp-cancellation.md)。

可在已初始化的本机测试 PostgreSQL 上单独运行（示例端口按实际修改）：

```sh
MIGRATION_TEST_DATABASE_URL=postgres://postgres:postgres_demo_only@127.0.0.1:55432/memz \
node --test --test-reporter=tap test/mcp-commit-cancellation.test.js
```

正常流程仅7次 HTTP（6次代理转发，1次旧会话核验），无模型或外部服务。代理只接受固定登录/候选/注销路径，限制16 KiB请求和64 KiB响应，并限制上游期限；不会输出cookie、CSRF、headers或body。测试有总watchdog，并等待MCP stdio、前后端socket、HTTP子进程和随机库实际关闭/删除。全部记录与账号均为原创或仓库公开合成fixture；不修改现有演示库，不构成生产取消、网络分区或任意提交中断点的完整证明。
