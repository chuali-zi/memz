# Verified package first-run smoke

2026-11-07，同一选定云环境，Node22.23.4。输入是原包 `/workspace/memz-verify/artifacts/submission/947b416de6ac-1794087831987-ae6fc3`，包提交 `947b416de6ac2327fafc6f54d1c28b61646100bc`；293清单文件加manifest共6,934,329字节。manifest SHA256：`6d0d238923f7ba9e73b7a62bae17a3124832a5bcf24cf8dd554b332300687ad9`。

一次实际运行通过，用时1887ms，22次HTTP尝试。原包始终只读；独立副本核验、安装、运行和清理完毕。`run.cjs`保留本次实际执行源码；命令argv/cwd、阶段退出、字节与hash保存在原始report。它按自身目录的父目录推导工作根，仅适用于预先核对为空且自有的 `/workspace/memz-package-smoke-*/evidence` 布局，不能在仓库或未来归档目录中原地运行。人工复现须先另建唯一私有scratch/evidence、确认app/foreign不存在并核对固定输入路径/工具；不要为刷结果直接重跑或覆盖本轮记录。此文件是取证源码，不是已验证通用清理安全性的安装器。

## 观察到的结果

- 原始包与复制后均通过完整manifest/内容/路径核验及包内离线verify；安装后与结束时核对所有manifested字节，原包未变。安装新增node_modules不冒充安装后全文件集verify。
- 使用既有公开npm缓存，`npm ci --offline --ignore-scripts --no-audit --no-fund`，两个新建空配置文件、精简环境；没有在线fallback。锁110项、hasInstallScript0，npm trace记录110个不同ADD路径。express、cookie-parser、pg及MCP SDK客户端入口的实际realpath均位于独立副本node_modules。未逐个手动resolve110个transitive entry；成功ci与本机HTTP运行实际加载了所需依赖。四条entry路径仍按运行时原值记录，安装目录事后已删除。
- 正式CLI从另一个foreign cwd直接启动，PORT=0；index/app.js/style.css的实际正文SHA与包一致，foreign canary404。setup-check、live、ready通过。
- 使用既有公共app角色、新随机数据库、原schema（只删除恰一条已存在CREATE ROLE声明）；没有改全局角色、现有用户库或共享容器。八表总行数14→23：source/fact/candidate/revision各+1、audit+3、receipt+2，项目/成员行不变，角色属性复核不变。
- source与candidate各同键重放，返回同ID；显式owner批准后viewer取得fact2/v1、candidate2与source5原文，另一项目账号403。判据是同ID、期望核心字段和独立DB增量/依据检查；不宣称完整回执的逐字节相等或事后全字段deep-equality。replay正文SHA可因JSON属性顺序不同而不同。
- 实际Node PID收到SIGTERM后exit0，无SIGKILL；HTTP socket、服务、owner/admin/cleaner连接与精确owned数据库均关闭/删除，清理无失败。app/deps/foreign只在postverify后删除，保留此evidence目录。

## 预算与限制

工作540秒+清理60秒，HTTP最多30、每请求2KiB/响应64KiB，应用内容8MiB中为清理留64KiB。本次账本work73,768+cleanup207=73,975字节；22个实际响应合计62,648字节。计量范围为父进程子命令输出、fixture/admin SQL/params/rows JSON及HTTP正文；post-materialization，不是堆、协议线缆、包/缓存文件或服务内部PG流量的硬上限。6.9MB输入包和npm依赖/缓存I/O不算这项应用内容账本。这里是有温缓存、已有PG/角色的首次独立工作目录运行，不是空机器、空集群、角色初建、生产部署或性能/SLO测量。

HTTP-only：没有MCP握手/桌面宿主、浏览器、模型、完整542项重跑或从loose package生成Git来源证据。副本安装前完整文件集无.git；命令设置GIT_CEILING_DIRECTORIES=/workspace，runner未git init。原report的gitRepository=false是该scope声明，并非执行git rev-parse得到的探针结果；不借此伪造clean Git工作树。仅包内完整性清单/已记录的原提交作来源，SHA不是数字签名。

原report的schema字段最终是SQL原/执行内容hash的metadata对象（不是版本化schema字符串）；保留原始碰撞结果，不回写原报告伪装新格式。身份/登录只保留计数/字节/状态，不写响应body、header、cookie、SID或CSRF值。npm debug只涉及这个精简环境下的公共缓存/空配置与锁定依赖；私有值/签名URL/auth模式扫描无命中。历史/原始数据和包均未改。

## 原始payload五文件SHA（加本README共六文件）

| 文件 | 字节 | SHA256 |
| --- | ---: | --- |
| run.cjs | 20789 | `3de8515879aaea2839681adfef9f9294d182f305abb19c3cc2ae9792593094bb` |
| report.json | 10715 | `4f05fbd215eab9eef6a88777984f4a8e858bdc42f19f7e44280c25b86c05f43e` |
| run.stdout.txt | 299 | `136af79277c344def4ce3251c7218683211797ab258d302ded0dbd0d8b3ac902` |
| run.stderr.txt | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| npm/2026-11-07T22_04_55_672Z-debug-0.log | 17234 | `53e27689a72a4d87cc29f6cdbf9abf767592112eceb03f8b47d0a015cd91550e` |
