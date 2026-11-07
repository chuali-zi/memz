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

## 2026-11-07 19:03 UTC 检查点

- 60ace1d：延迟写入失败仍显示错误，但不抢走用户正在编辑的焦点/caret；BODY失焦回退、Tab/Enter手动重试和原幂等键保留。真实Chromium新增4项先红后绿，原82与响应式4合计90通过。
- d9b3880：程序化基准query在序列化/取字段值之前验证完整自有字段和data descriptor，未知gold/evidence及accessor零读取；错误行id也不调用getter。纯回归9/9、独立16个合法/拒绝探针及真实服务合成集成12/12通过。没有模型调用，不能识别藏在合法文本里的gold，也不把Proxy视为沙箱。
- 82ece9c：内部 `decide` 与HTTP入口一致，只接受明确的approve/reject；缺省或拼错动作在业务SQL前拒绝。真实PG先复现undefined实际产生approved/revision/audit，再验证修复后5项及相关单元16项通过；有效审批、并发/权限/来源/过期版本和异常回滚均保留。
- a16188f：文档提交dfa7584的[CI](https://github.com/chuali-zi/memz/actions/runs/42402638748)发现产品UI81/82，完整日志确认为超限GET用例在初始facts尚未完成时拍下空baseline。受控HTTP gate先红后绿；fixture改等自己的实际row和busy状态提交，不用sleep或削弱旧页/游标/真实断连断言。新增1项后本云产品87+响应式4=91/91。

[a16188f完整远端CI](https://github.com/chuali-zi/memz/actions/runs/42403211763)已成功：core393/393、migrations9/9、产品UI87/87、响应式4/4、真实服务合成adapter12/12、retrieval19/19、两类SQL计划、真实停启恢复、完整PG UI与材料包步骤均通过。远端归档内系统目录 `artifacts/system/run-1794077465777-5f3093b5`，UI目录 `artifacts/ui/run-1794077588268-8142d444`；这些不是已下载到本机的文件。

- 379b517：备份改为唯一私有目录/文件，不截断旧备份；dump失败/空输出清理自身文件且变量清空，迁移显式短路，不依赖set -e，001失败不启动002。独立离线6/6、shell语法通过；文档仍要求验证这一次实际备份。修正npm wrapper PID信号说明，监督入口直接exec Node；Node22既有启动/排空11/11通过。
- 68884e9：归档[新备份helper的真实恢复检查](../evaluation/evidence/backup-helper-2026-11-07/README.md)，保留两次失败核验和最后通过的原始报告。最终实际归档34922 bytes、文件0600/目录0700、PG16.15恢复到独立空库后8表指纹与RLS策略相同；owned备份/容器/卷全部清理。已定位的失败是临时harness误查不存在的users表，第一份旧报告自身未定位具体阶段，不替它补写结果。测试时helper尚未提交，报告保留其确切文件hash，不声称clean整仓库取证。这轮已正常推送，完整CI待核实。

另完成一次只读浏览器可信边界检查：10/10合成真实Chromium探针通过，覆盖项目/身份/五列表/详情中的HTML、链接样式、Unicode文本及五列表旧分页切项目晚响应；没有动态标签执行、canary请求或非登录写入。未发现需改产品的缺陷，不重复制造回归。这不表示真实用户数据、屏幕阅读器或通用安全审计已完成。

68884e9的[完整远端CI](https://github.com/chuali-zi/memz/actions/runs/42404174234)随后成功：core399/399、迁移9/9、产品UI87/87、响应式4/4、真实服务合成adapter12/12及两类SQL计划/真实停启/完整PG UI/材料包均通过；远端归档内system `artifacts/system/run-1794078177248-36160fad`、UI `artifacts/ui/run-1794078316692-162c9b25`。

## 2026-11-07 19:10 UTC 检查点

- 2dbe346：固定静态根为应用自身public目录。真实CLI先红复现从临时cwd启动会提供该目录的canary；修复后临时/仓库两个cwd均返回仓库资产的同一SHA256，canary不暴露、存活正常且零DB调用。新2项及既有启动4项通过；不把其他备份/迁移命令也称为cwd无关。
- d2ef85d：GLM与DeepSeek共享调用前预算、strict usage及回显检查。独立先复现GLM同实例并发超过请求上限、Decimal低精度影响费用、入场失败释放锁后才halt，以及正常内层JSON转义回显漏检；改为同锁检查/预约/失败halt、独立512位金额上下文、有限的嵌套JSON扫描并保留duplicate键值，超限整份失败。DeepSeek runner全计划预检、同实例账本、失败不退款/不重试、保留not_run；明确simulation才用合成transport。两provider默认提示及历史351次实验材料未改。

预算代码最终全部Python99/99、22文件内存编译、原提示AST对照通过；独立审查另验证20个回显/边界探针、并发与halt反例及1280组Fraction精确金额对照。整合烟测还先发现共享helper破坏包路径导入，已修复并增加空环境包导入/两条原脚本CLI回归。全部验证使用空合成环境/阻网或明确fake transport，新增真实模型调用0。实际计数器和价格仍需独立核实；CLI没有默认counter loader，缺依赖在读凭据/transport前停止。金额是按配置预约，不是账单；每实例各自账本，已admit在途请求不可撤销，不检测任意编码秘密。

包含2dbe346与d2ef85d的[ba18f0e完整CI](https://github.com/chuali-zi/memz/actions/runs/42404960861)已成功：core401/401、migrations9/9、Python99/99、产品UI87/87、响应式4/4、adapter12/12及完整后续步骤通过。Node22远端system `artifacts/system/run-1794078735317-45e81e55`、UI `artifacts/ui/run-1794078853288-d599fa9d`。

同一ba18f0e在本云干净验证工作树、默认Node24.22.1独立通过core401/401、migrations9/9、完整真实PG UI、合成retrieval19/19并生成同提交材料包：system `artifacts/system/run-1794078691370-8c8d4140`、UI `artifacts/ui/run-1794078705238-cb9ac795`、材料包 `artifacts/submission/ba18f0e31a3f-1794078804272-c715a3`（均在 `/workspace/memz-verify`）。没有把跨提交或dirty源码报告拼包，Node22与24验证均不代表模型质量实验。

## 2026-11-07 19:20 UTC 检查点

- e123c17：CLI专用HTTP服务器在构造时固定headers10s、完整请求15s、检查1s及最多128TCP连接，保留keep-alive属性/原生buffer、socket inactivity0、16KiB正文和独立20s排空。先只读测量Node22/24默认60s/300s/check30s及连接满的原生直接关闭，再实现，不把拒绝连接称503。导入app仍由宿主管理server/信号/策略，native listen启动与运行时错误路径保留。

真实生产默认回归在Node22和24各3/3，持续滴入慢header约10997ms、慢body约16001/16003ms原生408，零会话/DB checkout；正常完整请求及后续恢复通过。原启动/运行时错误/排空13/13保持原断言。新连接满恢复用例在独立审查后改为等待实际getConnections归零，避免固定20ms稳定性假设，目标1/1重跑。另一独立Node24测试让完整POST入站后处理16200ms，仍返回200及完整正文，中途健康请求也200，仅最多2个owned socket；据此支持不误伤已完成入站后的业务处理。

包含e123c17的[da399ae完整CI](https://github.com/chuali-zi/memz/actions/runs/42405747977)已成功，core404/404、迁移9/9、Python99/99及全部后续步骤通过；远端system `artifacts/system/run-1794079328522-213aa26f`、UI `artifacts/ui/run-1794079467328-4f3d1ce7`。Node关闭会清除入站检查timer，因此不以新15s期限替代旧20s排空；测试和文档明确周期检查、事件循环与非SLO边界。

## 2026-11-07 19:39 UTC 检查点

- b2245ac：先在独立新Compose项目中复现Unix socket健康检查早于初始化完成，再仅将生产命令改为显式TCP的CMD argv，原2s/3s/30配置保留。新增离线配置回归与原通用checker合计9/9；新opt-in真实冷启动脚本不进入默认核心测试，不要求原生PG用户安装Docker。

独立root运行原始报告已保留在[冷启动证据目录](../evaluation/evidence/compose-first-start-2026-11-07/README.md)：旧检查在6443ms为healthy，但TCP exit2、init marker不存在；新检查在16266ms为healthy且TCP/marker均真，旧服务随后也完成初始化。运行总16878ms，owned容器/卷/网络全部确认为0；无发布端口、network none、缓存镜像且禁pull、仅合成4秒gate。报告含与b2245ac相同的runner/compose SHA，不将初始化观察时间称作启动性能保证或app schema/权限验收。初次探索fixture非零退出的原因仍未定位，未当作产品缺陷证据。

原Space报告已在同一文件身份上更新为第3版，保留11月6日完整历史原文并前置19:25检查点；本地版本metadata同步成功，没有创建副本或上传截图。历史阶段的“模型0/未push/旧HEAD”只适用于当时；当前报告明确区分仓库既有351次真实原创合成请求和本夜间阶段新增0次。

当前继续两项有依据的开发：把既有批准历史读取通过显式opt-in MCP暴露，并补native取消；为Node22/24准备固定loadgen、相同小profile与应用字节预算的成对工程smoke。原n80/page25测量合并HTTP与driver读取超过16MiB，因此不原样重跑；新样本不会用于稳定尾延迟、真实模型或换栈结论。尚未提交/运行部分按后续记录说明。LoCoMo下载未恢复，外部模型新增请求仍0，夜间窗口继续。

## 2026-11-07 20:27 UTC 检查点

- e76246c的完整CI成功，core405/405、迁移9/9及全部后续步骤通过；冷启动真实回归保持独立opt-in，不让原生PG核心测试依赖Docker。
- 5169172：新增显式opt-in历史MCP工具及宿主生成开关，仅分页/输出预算，复用批准历史与完整固定版本来源；默认工具顺序与生成JSON逐字节兼容。历史模块复用既有native取消与独立尽力注销，不增加stdin/任意日期/自动分页或审批。非PG兼容70/70、真实SDK→HTTP→随机PG6/6，旧修订与业务指纹保留、撤权整次失败、并发批准不替换已固定版本，临时库清理确认。[完整CI](https://github.com/chuali-zi/memz/actions/runs/42408352011)core440/440、迁移9/9和后续步骤成功。
- f0951c4：仅将CI PostgreSQL服务health同步为TCP。现有outage runner已有真实TCP connect+SELECT屏障而未修改；不把安装等待当就绪保证。该提交完整CI成功。
- ae30483：独立预算的小profile和显式child runtime，保留原legacy及历史原始证据；同Node24负载生成器、相同page10/n32/fixture。计量包装兼容pg原生callback/Promise，保留错误与清理；总deadline、child/owner/admin/DROP异常的剩余句柄均独立清理。Node22/24各9项纯回归、额外8组账本与12类cleanup故障注入通过。[完整CI](https://github.com/chuali-zi/memz/actions/runs/42409923848)core449/449、迁移9/9及完整后续步骤成功。

在ae30483同一干净固定验证工作树，root实际串行运行22.23.4→24.22.1两轮服务smoke，固定负载生成器24.22.1。各138次HTTP，126个reader成功、6个预期503、2个预期403、4个认证请求；意外0、恢复各12/12，两轮应用字节合计13924104/16777216、终末预约0、owned临时库及进程连接均清理。六份原始report/requests/resources和SHA已保存至[配对证据](../evaluation/evidence/reader-capacity-node-pair-2026-11-07/README.md)，独立审查逐字节、重算全部分母/分位数/byteledger通过。并发12的观测p95为36.18/25.79ms，但单对、每档32样本、固定顺序、非冷缓存与JSON计量开销使其不能作为runtime或换栈因果判断；完整六行表和RSS初始差异限制见该证据及reader-capacity说明。没有模型/token/费用测量。

- febfa88：合成真实CLI注入证明headers之后的错误转交Express默认handler会在development/production打印原异常；现只关闭该部分响应，不追加JSON或转交原异常，保留headers前合同和固定错误码日志。Node22/24各2/2、既有错误合同联合19/19通过。未读取真实secret或增加生产故障接口；该变更完整CI待推送后核实。

当前继续离线核查adapter的ingest/freeze是否也会在schema拒绝前读取未知getter，不以query已修替代所有阶段验证；不改已封存真实/合成原始结果。LoCoMo数据未取得、模型新增调用0，Space报告保持同一身份，后续再同步实测检查点；夜间窗口继续。

## 技术栈决定与主要缺口

目前继续Node/Express/PostgreSQL。现有测量是特定fixture的HTTP传输和真实模型小样本，不是语言/框架横向基准，没有证据说明更换语言能消除主要瓶颈。保留RLS、不可变revision、审批和幂等语义比立即重写更重要。若后续测量显示明确瓶颈，再在固定数据/硬件/并发和冷热条件下比较p50/p95/p99、吞吐、错误率、内存、读写成本；候选栈必须先实现相同接口合同和影子对照，再提供保留数据迁移、备份恢复、回退和分阶段切流方案。

优先待办：自然语言查询规划／历史路由的独立检索评估；服务生命周期与故障恢复；真实身份认证/会话存储方案；更大范围一致性与容量测量。不能把 substring 搜索称作语义检索，也不能因增加可靠性模块声称已经可公开生产部署。

远端已有 2026-11-06 的DeepSeek真实实验与原始usage，见 `benchmarks/memory/DEEPSEEK_RESULTS.md`。本云线程旧报告“模型调用0”只描述当时这一个执行阶段；不能据此否认后来其他会话的351次请求，也不能把原创合成工作负载当LoCoMo。当前本轮未新增收费模型调用；没有读取/打印/提交secret。

## 续做约束

每轮先读本记录、最新用户指令、git status、远端main和CI，确认无人正在写同一文件；保留所有尚未提交变更，不强推。用户允许Sol6.1 High多子智能体并行，代码由主代理审查后提交。测试通过才推送对应代码；明确dirty-run与clean提交证据。故障请求不自动重试写入。剩余时段做有测量/验证价值的实质改进，不空转或制造重复任务。到目标窗口结束时汇总实际提交、远端CI、未完成项和确切阻碍。
