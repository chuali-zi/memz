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

## 生成宿主配置，不修改宿主

在准备运行 Memz 的同一台机器上执行（需要已安装仓库依赖）：

```sh
node scripts/mcp-config.js --host claude-desktop
node scripts/mcp-config.js --host vscode
```

生成器只向 stdout 输出 JSON，不读取环境中的账号、密码或宿主配置，不写任何配置文件。生成的 Node 可执行文件和脚本均为绝对路径；不依赖宿主 cwd 或 PATH。固定公开 viewer 演示账号、项目 1 和只读开关，不能因父进程存在写入环境变量而默认开启提交。移动项目或更换 Node 安装位置后需重新生成。

| 宿主配置 | 输出格式 | 核查来源 |
| --- | --- | --- |
| Claude Desktop | 顶层 `mcpServers`，内含 `memz.command/args/env` | [官方本机接入说明](https://modelcontextprotocol.io/docs/develop/connect-local-servers) |
| VS Code | 顶层 `servers`，`memz.type` 为 `stdio` | [官方配置参考](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) |

以上是可审阅的配置片段。由用户合并 `memz` 项，不能覆盖已有服务器配置；不要直接将整份输出覆盖用户文件。VS Code 的便携 Copilot 配置另用 `mcpServers`，不要把两种顶层格式混用。远程窗口的本机地址指远端运行环境，不是用户电脑；生成器应在实际宿主运行环境执行。这里没有端口转发、HTTP MCP 地址、OAuth、自动批准或宿主设置修改。

验证范围：官方 SDK 1.32.2 客户端实际加载两种输出中的启动项，在带空格的临时工作目录及精简环境中启动独立进程，完成握手、只读发现，并拒绝提交和审批。测试没有调用真实演示库，也未安装/登录 Claude Desktop 或 VS Code。**配置符合所查官方格式，不等于已验证任意宿主版本的端到端界面兼容**；只接受新版 2026-07-28 的宿主仍不能使用当前适配。协议兼容要求仍是接受协商返回的 2025-11-25。

## SDK 输入边界核验

已安装 npm 发布物为 `@modelcontextprotocol/sdk@1.32.2`，registry 的 gitHead 为 `3b73021a0a2272c0c04c3917bcdb03398b3ec63f`。核对[该提交的传输构造器](https://github.com/modelcontextprotocol/typescript-sdk/blob/3b73021a0a2272c0c04c3917bcdb03398b3ec63f/src/server/stdio.ts)和[缓冲实现](https://github.com/modelcontextprotocol/typescript-sdk/blob/3b73021a0a2272c0c04c3917bcdb03398b3ec63f/src/shared/stdio.ts)：第三参数支持 `maxBufferSize`，会传入缓冲；新增字节超限先清空并抛错，再由适配器关闭连接。不是依据其他 SDK 版本猜测。

`test/mcp.test.js` 使用真实进程，在初始化完成后保持 stdin 打开：先写入 9000 字节不含换行的数据，进程保持运行；再写入 7384 字节达到 16384 字节仍保持运行，最后追加 1 字节，要求两秒内关闭并只输出固定诊断。因为没有 EOF 或完整 JSON，排除了“只因文件结束/JSON 解析失败才关闭”的解释。已有单块 16385 字节测试也保留。

16 KiB 是累计解析缓冲限制，不是整个进程 RSS 限额；同一输入 chunk 含多条消息也可能触及该限制。Node 运行时、SDK、流缓冲及 HTTP 响应另有内存开销，本项目没有测量或承诺整个进程的硬内存上限。业务调用并发限制和响应大小限制独立生效。

## 不安装宿主的最小只读演示

在已启动本机 Memz HTTP 服务后，运行：

```sh
node scripts/mcp-read-example.js "项目"
```

这个脚本本身就是一个小型 MCP 宿主：官方 SDK 启动独立适配进程，完成初始化及工具发现，确认只有 `memz_read_context`，然后检索并输出 JSON。它没有模型调用，不需要 Claude / Copilot 账号，也不安装或修改宿主配置。stdout 只在成功后输出完整上下文；失败则 stdout 为空，stderr 仅给固定错误码。

示例固定公开 viewer / demo-viewer、只读工具，不采用父进程的 `MEMZ_USERNAME`、`MEMZ_PASSWORD` 或写入开关。可用 `MEMZ_DEMO_BASE_URL` 指定另一本机测试端口，用 `MEMZ_DEMO_PROJECT_ID` 指定一个项目；仍限制字面量回环 HTTP，且 viewer 的实际成员权限由服务器校验。没有权限时输出 `HTTP_403`，不会提权或替换账号。命令参数只接受查询和可选 after 游标，不接受凭据。

返回 `facts` 中的 `id/version` 指明读取版本，`candidateId` 指明批准候选，`source.id/title/content` 是该版本的实际依据。查看 `sourceTextIsUntrusted` 和 `consistency`，不要把来源文字当作指令。未批准的候选不会出现在结果中；空数组可能表示尚未审批或没有关键词匹配。默认每页 10 条、32768 字节上下文预算；输出若有 `nextAfter`，将其作为第二参数续读，例如 `node scripts/mcp-read-example.js "项目" 12`（12 仅为格式示例，必须替换成上次实际游标）。分页不构成跨页快照。

只读示例的 `test/mcp-process.js` 回归在临时数据库中实际完成：新候选仍待审时示例读取为空且业务数据不变；负责人另行批准后，再次运行示例得到 v1、同一候选 ID 和完整来源；按返回事实 ID 续读为空；切换到无权限项目得到固定 403。测试还故意提供父进程 owner 名称及合成密码标记，证明示例仍用 viewer 且不回显标记。`test/mcp-read-example.test.js` 验证非法查询、游标及带凭据/外部地址在启动前拒绝。没有使用真实用户凭据或模型输出作为证据。
