# 显式生成字段问句工具配置

配置生成器现在可通过单独的 `--label-context` 开关，把已有只读字段问句工具加入待审阅的宿主JSON片段：

```sh
node scripts/mcp-config.js --host claude-desktop --label-context
node scripts/mcp-config.js --host vscode --label-context
```

不传该开关时，原配置输出逐字段保持一致，包括 `MEMZ_MCP_ENABLE_LABEL_CONTEXT: "0"`。显式开启只把这个环境字段改为 `"1"`，`MEMZ_MCP_ALLOW_PROPOSALS` 始终为 `"0"`，账号仍是固定公开 viewer 演示账号、项目仍为1、HTTP地址仍为 `http://127.0.0.1:3000`。不会读取父进程中的账号、密码、地址或开关来替换这些值，也不会自动开启任何写工具。

| 参数 | 发现的工具，按原顺序 |
| --- | --- |
| 默认 | `memz_read_context` |
| `--label-context` | `memz_read_context`、`memz_read_label_context` |

这只改变工具发现，不授予新项目权限，也不改变旧工具参数。字段问句读取仍是显式模板/label规划，并通过 `metadata_exact_v2` 读取批准依据；不是语义搜索，不调用模型。问题格式、完整性要求及两次独立快照边界见[字段问句读取说明](mcp-label-context.md)。生成器不会执行工具或读取项目数据。

Claude Desktop片段继续使用顶层 `mcpServers`；VS Code片段继续使用顶层 `servers`，并保留 `type: "stdio"`。command和脚本args分别为绝对路径，不添加shell引号、不依赖宿主cwd或PATH。路径包含空格时仍是JSON字符串和独立argv项，不应再自行拼成shell命令。

生成器仅写stdout，不读取或修改宿主设置，不创建凭据文件或部署服务。请审阅片段，再按宿主的既有方式合并 `memz` 项，不能直接覆盖已有服务器配置。它应在实际运行MCP进程的同一环境执行；云端/远程窗口的回环地址指那个环境，不代表用户电脑，也不自动提供转发、远程认证或公网支持。移动仓库或更换Node安装后需要重新生成。原本机接入边界见[MCP本机适配](mcp-local.md)。

开关可以放在 `--host` 前或后，每项只能出现一次；未知host、未知参数、重复参数、`--label-context=1` 或附带值均退出1，stdout为空，只打印固定usage，不回显输入。

模块调用保持旧API，可显式提供唯一的可选布尔字段：

```js
const {configuration}=require('./scripts/mcp-config');
configuration('vscode');                        // 原默认只读片段
configuration('vscode',{labelContext:true});    // 两个只读工具
```

options拒绝未知字段、非布尔值和访问器；不能通过它传入账号、地址、项目、selector或写入策略。`mcp-read-example.js` 的默认配置和行为不改变。

验证命令：

```sh
node --test test/mcp-config-label-context.test.js test/mcp-host-config.test.js test/mcp-read-example.test.js
```

新回归通过官方SDK启动真实stdio子进程，覆盖两种host格式、最小显式演示环境、默认1工具/开启2工具、只读顺序及空格脚本路径，确认拒绝未知工具并清理测试文件。它不连接HTTP/数据库，不调用模型，不表示安装、启动或验证了真实Claude Desktop或VS Code客户端。
