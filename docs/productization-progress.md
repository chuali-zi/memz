# Memz 产品化推进记录

目标窗口：北京时间 2026-11-07 夜间至 2026-11-08 08:00 左右。开发使用同一个新云环境；按实质阶段开发、验证、普通 fast-forward 推送，遇远端更新先整合。本文是续做记录，不是生产认证。

## 已交付阶段

| 阶段 | 变更与证据 | 提交／状态 |
| --- | --- | --- |
| 整合既有工作 | 保留本地 745490a、ceccd93、99dd46b、93232f1，同时合并远端 8212417、ff47b7c、4a59204；package scripts 冲突取兼容并集。Python74、core110、migration9、adapter集成12通过 | 44a45bf 已推送；远端CI core109/110，migration9通过，见下文 |
| 会话有界生命周期 | 最多1000项、8hTTL，创建时清理过期项；重新登录旋转sid/CSRF并撤销当前旧sid；满额503不驱逐有效会话，Retry-After60。单测与HTTP18通过，整套core124/migration9通过 | dbb7ca8 已随下一轮推送 |
| 表单体验 | 在途单次提交、提交反馈/aria-busy、异步候选响应项目隔离、来源保存不清新编辑草稿、键盘焦点。受控HTTP真实Chromium5项通过；真实PG UI全链路通过 artifacts/ui/run-1794062228491-a2c16c20 | 75cd230 已推送 |
| 启动前配置检查 | 离线Compose JSON声明检查，1MiB/5s限制、不回显配置；8项测试及仓库真实Compose规范化检查通过 | 1c50b70 已随ce57221推送 |

整合轮远端 CI：https://github.com/chuali-zi/memz/actions/runs/42382268148 。发现恢复阶段 `transaction_timeout` 不受 PG16 支持，runner默认dump/restore版本漂移是已知风险。75cd230的CI明确通过现有 `PG_TOOLS_CONTAINER` 路径使用 postgres:16 服务容器内的dump和restore，远端75cd230、ce57221、64fe59a、9e26ad1完整CI均已成功；未删除失败用例或把本地通过冒充远端通过。

本机测试PG16.15使用专用容器、公开合成账号，每套运行随机临时数据库并自行清理；不得将测试管理员URL指向生产。系统证据在 `artifacts/system/`，新增交互检查命令 `npm run test:product:ui`（需要Playwright Chromium，本云可指定 `CHROMIUM_PATH=/usr/bin/chromium`）。

## 后续轮次与当前检查点

- ce57221：工作区访问代次防A→B→A旧响应，冲突重填保留编辑中/已提交草稿；浏览器12项通过，远端CI成功。
- 252bb64：系统哈希和源码包加入核心测试实际依赖的memz adapter固定白名单，拒绝旧覆盖/缺失/篡改/符号链接，不复制gold、calls、语料或cache；相关28项通过。恢复文档明确dump+restore均使用16。
- 23ec396：有界DB等待、回滚失败保留原错误/弃连接、checked-out连接错误监听和脱敏错误；独立34项、隔离PG8项通过。
- 64fe59a：真实PG复现callback吞SQL异常时COMMIT返回ROLLBACK，严格检查命令标签防误报成功；单元16/隔离PG9通过，远端CI成功。
- 9e26ad1：浏览器固定15秒总期限含正文读取，失败不自动重试创建；5列表保留旧页、accepted query/status和游标；浏览器26项通过，远端CI成功。
- 2ab168f：真实PG协议代理丢弃source/candidate两次COMMIT完成帧；直连证明提交已发生，HTTP503且原键重放不重复；独立1项通过，完整系统回归待纳入。

固定9e26ad1的干净隔离工作树在同一云环境 `/workspace/memz-verify` 验证：core150/150、migrations9/9、retrieval19/19、product UI26项及完整真实PG UI通过；原始报告在其artifacts目录，system `run-1794063049408-b47f085a`、UI `run-1794063139496-7bd91341`。本地outage停启/已提交丢HTTP响应/同键恢复也通过，报告在主工作区 `artifacts/outage-report.json`。不要将此前64fe59a依赖目录准备期间的dirty-run报告作为clean证据。

本机另运行query plans（10 baseline+search comparison）和六组×三情形×20次上下文传输实验通过。共享来源25事实下，individual需28次请求/241603正文bytes，snapshot需3次/20055bytes；这是一项合成结构验证，运行时有其他套件并行，不用于跨栈速度、模型token或金额结论。报告见主工作区artifacts/query-plans.json和context-optimization.json。

后续已完成CLI有界优雅退出与5列表提交前回执验证，见下方各轮记录。每轮继续核实完整CI与源码依赖的材料包；尚未结束用户要求的夜间窗口。

## 后续交付与截至当前的验证

- 60b674c：CLI SIGTERM/SIGINT有界排空，HTTP与pool共用20秒；卡住handler/pool、重复信号、pipeline与真实PG锁等待回归。仅接管CLI，import不绑定信号。
- 156bf3f：整套发现COMMIT代理清理race，显式等待上下游socket关闭，保留严格清理断言；对应业务证据不改。bd4bd06 clean core159/migrations9及真实PG UI通过。
- bd4bd06：5列表在替换DOM/state之前验证分页信封、游标和必要来源字段；合法JSON坏形状先红后绿，浏览器38项。
- 6d30e10：浏览器harness取消gate时明确abort拦截请求、清理有界且失败仍报错；43项通过，CI独立步骤2分钟上限。旧项目DOM残留假设经3项控制测试未成立，未为此改产品。
- 54cb263、f533a33：纯字段模板与真实只读CLI；默认scope最多25，唯一完整模板后再取真实snapshot、exact筛选、修剪sources，输出selection/spans与modelCalls0；联合59、独立PG5与注销401无结束正文独立复验通过。
- e038e74、1cea35a：并发基线runner/方法与原始合成证据（282请求）；保留dirty源码hash与后续失败路径增强未重测的区别。`.gitattributes`保护原始证据字节，不改变历史SHA。
- 77f7971：脱敏且限长的失败TAP用例名进入CI日志，减少产物传递不可用时的诊断盲区。

此前完整远端成功检查点：[1cea35a CI](https://github.com/chuali-zi/memz/actions/runs/42387954090)。本地同提交干净Node24工作树core202/202、migrations9/9、完整真实数据库UI通过；system目录 `artifacts/system/run-1794066385049-61a50bb9`，UI `artifacts/ui/run-1794066386698-3994a7ac`（均在验证工作树）。没有以局部测试代替该提交的整套结果。

保留一项未归因的历史风险：[e038e74 CI](https://github.com/chuali-zi/memz/actions/runs/42386605465)为core174/175、migrations9/9；GitHub工具可解析产物身份，但当前消费端下载和受支持物化均未取得可读字节，网络原因未确定。未换执行器或改网络规则，未盲重跑旧CI。按该CI日志匹配并校验官方SHA的Node22.23.4，在同一云环境对同一e038e74干净工作树独立复现175/175+9/9通过（`artifacts/system/run-1794066777587-41e64f4d`）；因此暂未复现，不能称旧失败已归因/修复。Node22仅位于workspace临时toolchain，未替换默认Node24。

## 当前精确读取路径检查点

- 3a99b67：v2纯协议、完整标签校验及精确selector模板planner，共享证据校验机械提取，74项回归通过；原v1模板与header行为保持兼容。[该提交完整CI成功](https://github.com/chuali-zi/memz/actions/runs/42389424095)。
- 8a0e487：要求Node22+，与当前CI和官方仍受支持LTS保持一致；仅修改engines及锁文件根元数据，没有升级依赖或替换云默认运行时。
- fc4b294：独立的授权current-labels与context/exact HTTP路径。标签只读取subject/predicate、不读取value/source，最多512个完整标签；513个返回complete:false与空标签。精确读取在单个事务快照内校验current revision、已批准candidate、source和scope，损坏数据报错，不降级为空结果。POST只读错误与写入不确定错误分开，原/context合同未改。

fc4b294的新增HTTP5项、独立真实PostgreSQL8项通过，覆盖256/512/513、字面量特殊字符、权限/RLS、并发版本、坏指针及来源/正文超限；这是合成数据的真实服务验证，不是模型或LoCoMo评测。[完整远端CI成功](https://github.com/chuali-zi/memz/actions/runs/42390931415)。同一云环境的干净固定提交、Node22.23.4独立system core230/230与migrations9/9通过，目录 `artifacts/system/run-1794068716022-35be8691`（验证工作树）。

- df320d8：v2 CLI显式启用，默认v1保留；共享认证传输、完整输出预算和清理主错误优先。联合96/96、真实随机PG组合19/19；锁等待case由150ms调整为2000ms并确认目标请求实际进入PG Lock等待，受影响PG文件14/14重跑通过。metadata与exact仍是独立current事务，不声称共同冻结。
- 0a8da13：键盘登录后进入项目或重试按钮，成功恢复只清对应错误、不清较新的并发提示；浏览器50项通过。
- e5b6124：诊断命令删除重复URL期限覆盖，真实本机协议黑洞与既有隔离PG诊断5/5；期限按连接/单query计，不冒充全命令总期限。
- 18fda69：SDK写取消传到实际HTTP，发送前not_attempted、发送后unknown、独立有界注销；23项相关合同通过，不自动重试、不声称取消回滚。
- a6d7552：PORT严格十进制TCP解析，固定启动失败诊断；运行时listener错误进入同一个幂等排空流程而非只结束池。Node22生命周期11/11及独立runtime2/2通过，真实20秒到期、重复error/signal不二次end。
- 5ffca28：恢复测试工具TERM→250ms→KILL，等close才报错，固定60s/8MiB边界；Node22独立4/4与真实PG16 custom恢复1/1通过。Docker CLI关闭不等于容器进程已止，文档保留边界。

df320d8完整远端[CI成功](https://github.com/chuali-zi/memz/actions/runs/42392997911)，前一[a6d7552 CI](https://github.com/chuali-zi/memz/actions/runs/42392578980)也成功。同一df320d8干净验证工作树Node22 core282/282、migrations9/9通过，`artifacts/system/run-1794070109517-e2fc60f7`。

## 字段读取接入与当前完整检查点

- 7e93b2b、7cff7af：项目/bootstrap及事实/候选详情回执完整校验，拒绝错ID/版本/来源/比较状态，保护草稿、晚响应和固定历史版本；浏览器56、66项及原幂等4项分别通过。页面仍是各列表独立请求，不声称整页共同快照。
- fd80eab：实际产品SQL捕获与viewer/RLS下512/4096合成计划检查，16份EXPLAIN计划，无forced index、无HTTP或模型。4096词表仍拒绝，不把已知selector直接SQL检查当作模板支持4096。
- 079d293：模块级native AbortSignal，停止正在进行的实际读取/响应body及后续阶段，保留有界注销；联合69、隔离PG6通过。CLI/stdin不收signal，不保证HTTP取消会中止已开始的SQL或未知登录会话。
- 9954da4：MCP显式 `MEMZ_MCP_ENABLE_LABEL_CONTEXT=1` 增加question-only工具，固定项目/身份/protocol，默认清单及顺序兼容；大标签metadata仅内部使用，输出最多32768，超预算不截断/不断stdio。SDK合同35、隔离PG6通过，业务digest未变。
- c3d7587：真实PG提交后才触发SDK取消，7次有界HTTP确认注销、BUSY释放、同进程同键重放同pending ID，无重复记录或自动审批；Node22单项1/1，随机库与进程/socket清理确认。

该阶段完整远端成功检查点：[c3d7587 CI](https://github.com/chuali-zi/memz/actions/runs/42394780746)。同一干净提交在Node22.23.4本云验证core314/314、migrations9/9与完整真实PG UI通过，分别在验证工作树 `artifacts/system/run-1794071294367-8c5225f2`、`artifacts/ui/run-1794071294846-4b1fc9f2`。同提交实际SQL计划报告已按原字节保存在 `evaluation/evidence/exact-reader-plans-2026-11-07/`，115889字节报告及README的SHA256均核对通过；报告保留source clean状态、原始计划、数据hash、并行/热状态限制与随机库删除确认。这些是真实服务/数据库上的合成工程回归，不是新增模型或LoCoMo实验。

## 2026-11-07 18:41 UTC 检查点

- c0ab6ba：浏览器完整响应限制1MiB并严格校验UTF-8，总期限包含body；异常创建保留原幂等键，已知失败不被清理错误覆盖。产品浏览器76项通过；固定提交在本云使用独立容器完成真实数据库停启恢复。
- 14e8875：每个池最多32个未完成checkout交接，包含握手及promise交接窗口；满额在connect/BEGIN前返回503/Retry-After1，成功和失败均释放预约。原10个连接上限保留；这是固定准入边界，不是吞吐或延迟保证。
- f29e186：HTTP聚合读取在同一快照中先检查行数、字段和总字节，再读取正文；最多512行（audit100）、原始与投影各4MiB，超限整体422并提示分页，不截断。内部评测全量baseline保留。纯单元26及隔离PG9项通过。
- 2a0bd13：context-process回归改用独占随机库和角色，保留11项原断言，避免外部审批影响两次独立读取；有界子进程和清理均验证。历史[4dfbf84 CI](https://github.com/chuali-zi/memz/actions/runs/42395288504)为core313/314、迁移9/9，已知失败标题属于该套件，但原始TAP未取得，不能断言该历史失败已确切归因。共享数据库竞态已独立复现；隔离后该套件及后续完整CI通过。
- 74bbf10：登录/注销回执先验证后提交界面状态；保留原opaque CSRF、不写DOM或storage；注销单次在途，坏回执保留草稿。产品浏览器82项通过。本云干净Node22提交core338/338、迁移9/9与真实PG UI通过，验证工作树目录为 `artifacts/system/run-1794073705701-cf924380` 与 `artifacts/ui/run-1794073706206-e9254c1e`。
- 7934b7d：MCP配置生成器显式 `--label-context`，默认输出兼容，始终关闭提议工具；9项回归通过，包括官方SDK的真实stdio子进程，不代表已安装或验证真实桌面宿主。
- d974917：v2问句上限210，支持两个各100字符标签及完整连接词；v1仍为200。联合90项及隔离PG7项通过；211字符拒绝且零HTTP，gold未被读取。
- 755a8ac：SQL计划捕获移除两层异步转发造成的错误交接窗口，使用native callback及短错误桥；30项离线回归通过，旧原始证据hash不改，后续CI真实SQL计划继续通过。
- e8c65f4：页头及长名称/提示的实际换行，320/360/768/1280四种宽度真实Chromium回归通过，完整文本保留，无隐藏溢出来掩盖内容。
- e579134：[本机health探针](health-probes.md)复用现有池及事务准入；liveness不访问数据库，readiness只读单条catalog检查。GET/HEAD及条件请求实时固定响应，沿用本机Host和停机gate，不创建会话、不输出配置或原始错误。诊断共享目录检查，覆盖角色、RLS、表/列/类型、迁移和名称解析基本前提；并非业务或生产安全认证。

最新完整远端成功检查点为[e579134 CI](https://github.com/chuali-zi/memz/actions/runs/42401374090)：core386/386、migrations9/9、产品UI82/82、响应式4/4、真实服务合成memory adapter12/12；query plans、exact-reader plans、真实数据库停启恢复、完整PG UI与材料包步骤均成功。系统原始报告目录 `artifacts/system/run-1794076115123-f1450b1d`、UI目录 `artifacts/ui/run-1794076246936-99053ab4` 是该远端CI归档内路径，不能当成本机已下载文件。Python准备任务也成功。后续工作树改动与新提交另行记录，不将局部验证代替完整CI。

数据阻碍仍独立存在：本轮以最新Library搜索完整结果和当前官方helper做一次有界下载，失败于 `hosted_apps_tools_list / network_failure`，尚未进入materialization，消费端没有取得归档或部分字节。状态为网络原因待恢复/待确定，不是权限拒绝或保险库配置失败；未绕过其他网络限制、未换执行器或连续盲试。未进行SHA256、tar成员及LoCoMo数据校验，未新增模型请求。仅脱敏状态保存在工作区 `/workspace/library-diagnostics/benchmark-prep-library-7263m5rz/status.json`。GLM保险库条目及覆盖范围已由用户证据确认；当前任务不能据此推断请求名称、发布或运行时注入，未要求用户重复核对已确认设置。

下一轮正在落实DeepSeek实验入口与已有SpendGuard的一致性，包括严格执行标志、调用前累计预算、异常usage和响应凭据回显防护；真实价格/tokenizer未核实时继续fail closed。这些开发和模拟验证不改写2026-11-06已有351次真实请求的历史证据，也不新增外部模型调用。夜间窗口继续进行。

## 技术栈决定与主要缺口

目前继续Node/Express/PostgreSQL。现有测量是特定fixture的HTTP传输和真实模型小样本，不是语言/框架横向基准，没有证据说明更换语言能消除主要瓶颈。保留RLS、不可变revision、审批和幂等语义比立即重写更重要。若后续测量显示明确瓶颈，再在固定数据/硬件/并发和冷热条件下比较p50/p95/p99、吞吐、错误率、内存、读写成本；候选栈必须先实现相同接口合同和影子对照，再提供保留数据迁移、备份恢复、回退和分阶段切流方案。

优先待办：自然语言查询规划／历史路由的独立检索评估；服务生命周期与故障恢复；真实身份认证/会话存储方案；更大范围一致性与容量测量。不能把 substring 搜索称作语义检索，也不能因增加可靠性模块声称已经可公开生产部署。

远端已有 2026-11-06 的DeepSeek真实实验与原始usage，见 `benchmarks/memory/DEEPSEEK_RESULTS.md`。本云线程旧报告“模型调用0”只描述当时这一个执行阶段；不能据此否认后来其他会话的351次请求，也不能把原创合成工作负载当LoCoMo。当前本轮未新增收费模型调用；没有读取/打印/提交secret。

## 续做约束

每轮先读本记录、最新用户指令、git status、远端main和CI，确认无人正在写同一文件；保留所有尚未提交变更，不强推。用户允许Sol6.1 High多子智能体并行，代码由主代理审查后提交。测试通过才推送对应代码；明确dirty-run与clean提交证据。故障请求不自动重试写入。剩余时段做有测量/验证价值的实质改进，不空转或制造重复任务。到目标窗口结束时汇总实际提交、远端CI、未完成项和确切阻碍。
