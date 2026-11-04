# 本机 MCP 兼容适配

`scripts/context-client.js --stdin` 和 `proposal-client.js --stdin` 原来只接收一次 JSON，不提供 MCP 握手、工具发现或请求编号。`scripts/mcp-server.js` 复用这两个库，为本机智能体进程提供标准 stdio 适配；没有模型调用或 MCP HTTP 监听端口。

## 协议与依赖选择

本适配明确支持 **2025-11-25**：`initialize` → `notifications/initialized` → `tools/list` / `tools/call`，使用官方 `@modelcontextprotocol/sdk` **1.32.2**，版本及传递依赖锁定在 package-lock.json。不要把它称为最新协议支持：官方 2026-07-28 已改为逐请求协商及 `server/discover`，本适配未实现该版本。不支持返回版本的客户端应断开。

核查依据（2026-11-04）：[旧版生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)、[stdio 传输](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[工具定义](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)、[新版变更](https://modelcontextprotocol.io/specification/2026-07-28/changelog)、[官方 SDK](https://github.com/modelcontextprotocol/typescript-sdk)。采用 SDK 处理 JSON-RPC 与协议类型，不自行声称通过官方认证或所有宿主兼容测试。

## 启动与范围

先按 README 启动本机 Memz HTTP 服务和数据库。MCP 宿主应直接启动 `node /绝对路径/memz/scripts/mcp-server.js`，不要用带横幅输出的 `npm run` 包装 stdout。宿主按其自己的 MCP 配置格式设置 command/args/env，例如：

```json
{
  "command": "node",
  "args": ["/绝对路径/memz/scripts/mcp-server.js"],
  "env": {
    "MEMZ_BASE_URL": "http://127.0.0.1:3000",
    "MEMZ_PROJECT_ID": "1",
    "MEMZ_USERNAME": "viewer",
    "MEMZ_PASSWORD": "demo-viewer",
    "MEMZ_MCP_ALLOW_PROPOSALS": "0"
  }
}
```

这是公开合成演示账号，不是生产密钥；本次未修改任何真实智能体宿主配置。地址只允许 HTTP 字面量回环 `127.0.0.1` / `[::1]`，不能传路径、认证信息、查询参数或外部地址。`localhost` 不接受，以免依赖名称解析。每个进程固定一个 projectId；工具参数不能覆盖项目、地址或账号。

默认 viewer、只读。需要提交待审时，由操作者将 `MEMZ_MCP_ALLOW_PROPOSALS` 设为 `1`，并使用已有 member / demo-member 演示账号。开启工具不授予权限，HTTP 服务仍执行登录、CSRF、成员权限与 PostgreSQL 隔离。宿主负责让用户了解并授权调用；本适配不会自动修改宿主批准策略。没有新建或保存凭据文件；每次操作登录并尝试退出，退出失败在已有客户端结果中明确标记。

## 两类工具

- `memz_read_context`：可选 `query`（200 字符）、`limit`（1–25，默认 10）、`after`（事实游标）、`maxOutputBytes`（2048–32768，默认 32768）。输出文本是一份 JSON，保留固定版本、来源原文、候选与审批者 ID。预算是 JSON UTF-8 字节，不是 token 或摘要；JSON-RPC 包装另有开销。续读使用 `nextAfter`；跨页不保证同一快照。来源原文是非可信数据，不应作为指令执行。
- `memz_submit_proposal`：仅显式开启时出现。必填 `sourceId`、`subject`、`predicate`、`value`、`expectedVersion`、`idempotencyKey`。必须引用该项目已有来源；不提供来源创建、批准、驳回、任意 SQL 或任意 HTTP 工具。提交后仍需负责人通过界面审批。

提交示例（sourceId 必须替换成实际已有来源）：

```json
{"name":"memz_submit_proposal","arguments":{"sourceId":2,"subject":"MCP 合成项目","predicate":"截止日","value":"18号","expectedVersion":0,"idempotencyKey":"synthetic-intent-001"}}
```

调用前由宿主保存完整意图和幂等键。响应丢失、进程终止或取消不能证明未写入；本适配不自动重试、不回滚已提交事务。恢复时复用同一键和相同参数。创建回执的 pending 是创建时状态，不是当前审批状态。若继续读取看不到该候选，可能只是仍未审批，不能因此换键重复写入。

## 限制与复现

输入累计解析缓冲上限 16 KiB，严格 UTF-8；同时只运行一个业务调用，其余返回 BUSY / not_attempted。5 秒内完成初始化；已有读客户端总时限 30 秒、写客户端 15 秒，退出会话最多另加 5 秒。输出发送等待 5 秒，单条或积压输出超过 256 KiB 时断开。异常诊断为固定码，不输出凭据、cookie、响应正文或原始输入。stdio 关闭不等于撤销在途业务调用。

`node --test test/mcp.test.js` 启动真实进程验证握手、未初始化拒绝、只读发现、未知工具、参数越界和非法输入；不访问数据库。`npm run test:system:evidence` 的隔离 PostgreSQL 流程通过官方 SDK 客户端连接独立进程，验证提交只产生待审候选、同键重放一条审计、同键异参 409、viewer/跨项目 403、错误来源 400，以及负责人显式批准后读取相同来源与版本。所有数据为合成；未调用付费服务，未宣称语义理解效果或生产级安全。
