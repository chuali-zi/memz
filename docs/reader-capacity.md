# 当前栈的有界 HTTP 并发基线

本实验补充当前 Node.js/PostgreSQL 栈的单页快照读取观察：固定工作量下的闭环吞吐、经验尾延迟、Node 子进程资源采样，以及连接池占满后的有界失败与恢复。没有其他技术栈或关闭防护的对照，不能据此推断换栈收益、资源防护的净开销、最大容量或生产 SLO。

它不重复 [查询计划](query-plans.md) 的 EXPLAIN/BUFFERS，也不重复 [上下文表示消融](context-optimization.md) 的六种表示、来源去重和360次串行采样。旧消融的时间包括每次 readContext 登录、读取、验证、输出组装及注销；本实验复用会话，直接 HTTP GET 快照端点，二者不能直接合并比较。

## 独立运行

需要 Node.js 22+、已安装的仓库 npm 依赖、共享 memz_app 角色已初始化的本机 PostgreSQL 16。先协调停止同机其他数据库和浏览器测试，记录实际协调范围；运行器本身不控制其他进程或共享硬件。

在仓库根目录运行，以下是无需修改 package.json 的独立 npm 命令：

```sh
CAPACITY_DATABASE_URL=postgres://postgres:postgres_demo_only@127.0.0.1:55432/memz \
CAPACITY_NOISE_NOTE='已协调本机测试暂停；其他系统负载未受控制' \
npm exec --offline --call='node evaluation/reader-capacity.js'
```

也可直接执行 `node evaluation/reader-capacity.js`。端口应填写自己的测试实例实际端口；示例55432是开发测试容器的宿主映射。连接实际解析目标必须为本机回环地址。不要使用真实业务管理员连接。密码、cookie、CSRF 和原始连接 URL 不写入结果。

脚本不修改传入管理员 URL 指向的数据库，而是新建随机 `memz_capacity_*` 库；仅在该库加载 schema，并由 schema owner 显式初始化原创合成批准记录。没有自动批准真实数据、模型抽取或模型调用。应用子服务独立运行，使用非 owner 的 memz_app 连接，只监听随机本机 HTTP 端口；连接池控制只通过父子进程私有 IPC，不新增业务端点。

默认输出 `artifacts/reader-capacity/run-时间-随机值/`；可用 `CAPACITY_OUTPUT` 指定新目录。拒绝覆盖已有 report/requests/resources 文件，不自动重跑失败实验。它不进入默认核心测试或 CI；提交前后的开发测量与同提交 clean 证据应分别保留。

## 固定数据与请求预算

固定 seed=42，LCG 生成512条原创记录，项目1与2各256条，每条独立来源正文恰为1024个 ASCII 字节。记录生成 SHA-256，并从真实表联查生成记录，逐项比较并记录实际数据 SHA-256。哈希覆盖生成的主体、属性、值、来源标题/正文和提议人；不是整个数据库含时间戳的物理备份哈希。

schema 自带种子仍保留并单独统计，不能将512误报为数据库总量。当前 schema 的初始化数量为：projects=2、memberships=4、sources=4、facts/candidates/revisions/audit各1、idempotency_requests=0；加上实验记录后，实际为sources=516、facts/candidates/revisions/audit各513，其余不变。报告保存初始化前后八张表的实际总行数，结束前复核无变化。

快照查询固定 `q=容量基准&limit=25`，保留默认 substring 语义；五个固定游标读取首页及较深页。每档用相同 seed 序列选择游标，避免把不同档的页面组成变化当作并发影响。每份成功响应都验证快照协议、25条事实的 ID/标签/值/版本/来源以及完整来源正文哈希。项目范围通过真实 viewer/other 会话反向检查。

| 阶段 | 并发 | reader GET 数量 |
| --- | ---: | ---: |
| 新进程的首次数据读取 | 1 | 1 |
| 每档预热 | 1、4、12 | 17 |
| 每档正常测量 | 1、4、12 | 80×3=240 |
| 连接池被本 fixture 持有全部10个客户端 | 6 | 6 |
| 释放连接后的同会话恢复 | 6 | 12 |
| 跨项目禁止读取 | 1 | 2 |
| 合计 | — | 278 |

另有2次登录、2次注销，共282次 HTTP，程序硬限制最多299次，不自动重试。占满连接池只持有本子服务的客户端，不终止其他 PostgreSQL 后端或停止数据库容器；预期6个请求约在5秒 checkout deadline 后返回503，释放后12次成功。故障阶段与正常吞吐阶段分开，不以预期503充当正常成功，也不从延迟分母中删除失败。

## 时间、资源与原始证据

- 单请求最多8秒，信号覆盖响应正文读取；单响应最多1 MiB。超限、断连、截止或校验失败都保留状态、已接收字节数、部分/完整标记与已接收数据的 SHA-256，不输出底层错误消息。
- 整体执行最多90秒，清理另限10秒。达到执行 deadline 会取消 HTTP、停止子进程并断开本 fixture 的直连；清理只删除自己创建的随机库。清理失败令结果失败，不伪造资源已关闭。
- `requests.jsonl` 保存全部282次请求的原始记录，包括预热、认证、403和503；有序 ID、阶段、worker、序号、开始/结束时差、HTTP 状态、完整正文读取时延、含 JSON/协议校验的完成时延、字节、哈希、校验结果及固定错误代码。报告保存计划数量、实际尝试数量、状态/错误计数，失败时也保留已取得样本。
- `resources.jsonl` 保存子进程100ms定时采样及阶段边界 IPC 采样：RSS、累计 user/system CPU 微秒、pool total/idle/waiting/held、采样接收时间和丢弃采样数。资源控制消息与采样有少量开销；本实验不剥离它们。
- `report.json` 保存提交、dirty 标志、相关源码哈希、Node/PG/CPU 环境、应用限额、全量数据计数、每阶段汇总、原始文件 SHA-256、清理结果和噪声记录。其他数据库连接的数量/活跃数及 load average 在开始和结束观察；数量中包含运行器自己的管理员连接，不记录其他数据库名或 SQL，也不能据此证明全程无人干扰。

吞吐使用各阶段从派发到全部请求完成的时间；另列有效200 goodput。原始记录同步落盘的负载生成器开销会进入闭环阶段耗时，单请求 elapsed 在记录落盘前取得。每档同时列全部尝试和有效200的延迟，不把快速失败解释为吞吐改善。RSS/CPU 只属于应用子进程，不包含 PostgreSQL、负载生成器或系统整体内存。

## 解释限制

每档只有80个正常样本，nearest-rank p99 恰好是观测最大值；不能将小样本最大值宣称为稳定的99分位或作毫秒门槛。各档顺序固定为1→4→12，数据已经被初始化/ANALYZE触达；首次数据读取前也完成了两次认证。没有清空 PostgreSQL/OS 缓存或控制 JIT，因此只称“新进程首读”，不称冷缓存实验。

负载是无思考时间的闭环 worker：某请求变慢会推迟后续发起，存在 coordinated omission。它不是开放到达负载、长时稳态、最大 QPS、真实用户分布、写入竞争或容量上限测试。并发12时每档可能只有少数周期资源样本；sampledMaxPoolWaiting=0 不证明从未排队，采样 RSS 最大值也不是连续监测峰值。应结合所有原始序列、请求分母和工作量大小阅读。

## 首次开发测量记录

原始目录：`artifacts/reader-capacity/run-1794064899700-b9f1b4b3/`。该次基于提交 `6d30e10bae5bacf821aed4f64ca3ec6182767602` 的 **dirty 工作树**，不是 clean 提交取证或 CI 成绩；报告记录当时脚本及应用源码哈希。Node 24.22.1、PostgreSQL 16.15，512条生成数据的生成/实际内容哈希均为 `564ce2e4d666ff078661606987e1e3870d80b05a2a08bf631691aacc6a69693c`。

可随源码复核的 [原创合成证据小包](../evaluation/evidence/reader-capacity-2026-11-07/README.md) 保存三份原始文件的逐字节副本和 SHA256SUMS；它保留上述 dirty 来源身份，不是当前 main 的 clean 负载报告。

以下测量使用原报告记录的脚本哈希，原报告及原始样本保持原样。测量之后只补强失败路径及源码覆盖元数据：等待所有已启动 worker settled 后汇总、预算检查后才递增 HTTP 分母、清理超时后禁止继续创建连接、等待子进程 stdio/IPC 收尾，以及为未来报告补入实际 gate 依赖 `scripts/server-lifecycle.js` 的哈希。成功测量没有再次运行；不能把历史报告的源码覆盖或哈希改写成当前脚本版本已经完成负载回归。

| 并发 | 有效200/尝试 | 观测 goodput/s | p50 ms | p95 ms | p99=max ms |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 80/80 | 155.52 | 6.12 | 7.92 | 9.73 |
| 4 | 80/80 | 380.71 | 9.97 | 13.78 | 15.26 |
| 12 | 80/80 | 570.15 | 19.30 | 27.46 | 32.52 |

执行6519ms、清理34ms。连接池占满阶段6/6返回预期503，观测完成时延约5003ms；释放后12/12恢复200，2次跨项目读取均403，282条原始请求中无意外样本。采样81次，Node RSS观测最大96927744字节（约92.44 MiB），pool total最大10，waiting最大6；故障阶段的 RSS 不能混作正常负载阶段的独立峰值。

主代理、engine 与 experience 在本次测量前协调暂停本机测试；仍未控制其他系统活动。load average开始为0.15/0.14/0.30，结束为0.14/0.14/0.29；其他数据库连接观测为1、活跃0（包括控制管理员连接）。这仅为本次小工作量基线，未建立需要换栈的证据，也未证明当前栈可承担未测的生产负载。

## 显式 Node 配对工程 smoke profile

新增 `CAPACITY_PROFILE=node-pair-smoke-v1`，用于未来在同一 clean 提交、独占测量窗口内作两次小工作量工程观察。原默认 page25/n80、Node22+ 入口和上述 dirty 历史证据不变；该 profile 不是原实验的重跑结果。目前只有纯函数、fake driver 和实际路由回调的离线验证，尚未执行真实配对测量，不能据此报告 Node22/24 性能差异。

固定 fixture 仍为 seed42 的512条记录、每项目256条、每条独立1024字节来源，生成 SHA-256 仍为 `564ce2e4d666ff078661606987e1e3870d80b05a2a08bf631691aacc6a69693c`。只将页面改为10条，每档正常样本改为32；并发仍1、4、12，预热17、首读1、池占满6、释放后恢复12、跨项目拒绝2、认证4均保留。每轮严格最多138次 HTTP，两轮共276次，不自动重试。每档 nearest-rank p95 是第31个排序样本，p99 就是最大值；该样本量只能作为工程 smoke，不能支持稳定尾延迟、生产 SLO、最大容量或语言/框架换栈结论。

负载生成器固定为 Node24；只改变子应用的显式受信任 Node22/24 二进制。`CAPACITY_APP_NODE` 必须是可执行文件的绝对路径，realpath 文件名为 `node`，实际 `--version` 必须为22或24稳定版；不用 shell、动态 import、PATH 或其他环境变量补全该选择。child ready 消息再次核对实际版本与 execPath。子应用使用当前 CLI HTTP factory 的入站设置；私有 IPC 的实验清理仍属于运行器，不等于生产信号生命周期的对照实验。新 profile 的子应用只继承合成 DATABASE_URL，不继承其他 Node 环境开关。

未来运行示例（需先协调独占窗口；以下并未自动执行）：

```sh
CAPACITY_DATABASE_URL=postgres://postgres:postgres_demo_only@127.0.0.1:55432/memz \
CAPACITY_PROFILE=node-pair-smoke-v1 \
CAPACITY_APP_NODE=/trusted/node22/bin/node \
CAPACITY_NOISE_NOTE='记录本次协调范围及仍未控制的负载' \
/trusted/node24/bin/node evaluation/reader-capacity.js
```

随后在相同条件、同一 clean 提交下，另开新输出目录，保持 Node24 负载生成器并仅将 `CAPACITY_APP_NODE` 改成受信任 Node24 路径。固定顺序22→24会留下顺序与系统状态混杂，不把单对结果解释为 Node 版本的因果优势。任何失败都保留原始结果，不自动重跑补齐“好看”的样本。每轮开始要求 clean，结束复核同一提交和 clean 工作树；相关源码哈希新增覆盖 HTTP factory、证据/协议 helper 和 lockfile。初始化与 ANALYZE 已触达 PG/OS 缓存，首读仍只称新进程首读。

### 两轮应用字节账本

两轮总额度为16 MiB，每轮固定分给 parent 5 MiB、child 3 MiB，不能跨分区借用；每个进程分区中另预留16 KiB给 ROLLBACK/DROP 清理。计入 HTTP 出入站正文，以及 PG 查询 UTF8、参数 JSON、全部 `result.rows` JSON（多 statement 的每个 Result 也计入）。范围包含管理员/owner 的 schema、初始化重复 JSON 参数、校验查询、应用事务和清理。它不是 PG/HTTP wire 字节、headers、认证包、堆占用、IPC 或诊断日志；没有将这些范围冒称为完整网络流量或内存上限。

每次操作在启动前同步预约输入加返回投影的保守上界，包含并发中的预约；超额在 fetch/query 前拒绝。成功 reader 响应固定32 KiB，认证与预期错误正文1 KiB；当前固定 fixture 的完整事实、来源和 provenance 投影上界为16004字节。SQL 只接受本 profile 已列明的查询形态和有界参数，未知 SQL 在执行前拒绝，不能以默认小上界继续执行。driver 包装同时保留 Promise 和两种 callback 形态，不包 pool.connect、不叠加 release/reuse 包装。HTTP 分母只在预约成功后增加，拒绝预约体现在账本 denied 计数中。

这些是固定原创 fixture 的成功合同，不是任意坏数据的硬分配保证：HTTP reader 的一个 chunk 可能已超过剩余额度，PG 异常结果也可能已被 driver 物化。运行器记录实际字节而不截短或 clamp，取消剩余 HTTP、标记 overrun/unmeasured 并令整轮失败；不能把事后检测写成“从未超过”。成功结果必须所有投影/分区成立，最终 reserved=0，无 denied/overrun/unmeasured，并在全部业务 HTTP settled、含403的回滚完成后主动取得 child 最终账本；旧周期采样不能冒充完整终值。执行/清理期限及异常 child 退出都令结果失败；child 退出异常仍继续关闭 owner/admin 并尝试删除自建随机库，清理失败不伪造 closed/dropped。

当前纯模拟完整138请求与初始化/校验/清理，得到每轮 parent 4695527、child 2266542 字节，两轮投影13924138字节，低于16777216；并发预约峰值分别4798904、2266644。该值来自 fake driver 和实际路由回调，不是 PG/HTTP 实测，也不是延迟或吞吐数据。未来必须同时检查两份报告及原始请求；只把两份均通过、相同 fixture/profile/source 的报告合为一对。RSS仍是含 instrumentation 的子进程采样值，不包含负载生成器或 PG，也不是连续峰值。

纯回归独立命令 `node --test test/capacity-profile.test.js` 不连接 PostgreSQL、不监听 HTTP、不启动 benchmark child；它覆盖账本、native callback、多结果、未知查询、完整阶段预约和失败清理。真正测量须待 clean 固定提交和协调窗口，不因该纯测试通过而自动执行。

计量本身会改变工作量：PG 每个结果都再次 JSON.stringify 计数，增加 child CPU 与临时分配；HTTP 哈希、JSON/协议校验、同步原始文件落盘也进入闭环成本。这是带计量的固定 profile，不能称为未加仪器的生产原生延迟或 RSS；Node22/24 观测差异也不能直接当作应用收益或换栈收益。单个 owner/admin/cleaner 的关闭或连接阶段各限1秒，DROP 限2秒，超时实际 destroy 相应 transport 并记录失败，继续剩余 owned 清理；总清理仍限10秒。拒绝、挂起、DROP失败或强杀都使报告失败，即便随后成功删库也不抹去失败。
