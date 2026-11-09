# Memz 产品化推进记录

> 历史推进记录：2026-11-09 起产品主线已转向智能体漏洞知识库。后续工作按 [新需求](cve-product-direction.md)、[检索树设计](cve-retrieval-tree.md) 与 [CVE STATUS](../cve/STATUS.md) 推进；下文旧的夜间目标、项目记忆与比赛计划不再是待续任务。

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

## 2026-11-07 21:08 UTC 检查点

- a5b3398：prepare/ingest/freeze/query 的有限 artifact schema 在 canonical/hash 或网络前检查 own descriptor，拒绝 getter、隐藏/Symbol/toJSON 字段和非法数组索引；正常 JSON/共享来源的五个旧 hash 与42次HTTP轨迹不变。Node22/24纯21/21；完整CI core463/463、adapter12/12通过，不把普通对象保护称作Proxy沙箱。
- a54d2df：详情请求保留最新意图，BODY失焦才恢复仍连接的当前按钮；刷新核对不抢用户正在编辑的草稿/caret。Chromium先红后绿，产品95+响应式4=99/99，完整CI通过。
- 8cae134：批量版本依据POST正确标记为只读；数据库503提示与GET/exact一致，来源/候选写入不确定提示保留。真实loopback+合成pool失败联合13/13，无PG或模型；完整CI通过。
- 8c8e316：membership.active默认true，停用保留原role、actor外键、不可变历史与创建回执；新迁移003重复/并发保留false，坏字段或DDL失败整体回滚。真实同session撤权、直接8表RLS、旧键重放、跨项目和已有RR快照边界新增9/9，原迁移9/9；27HTTP、199141应用字节、9随机库全部清理。没有增加成员管理API或应用更新membership的权限。

readiness/doctor只查目录，检查active普通列及受支持的精确成员函数源码/配置/签名，同时确认函数owner实际具备读取及绕过membership RLS的前提。独立PG先复现canonical函数转给app后旧检查仍ready、真实调用却54001；修复后为SCHEMA_PREREQUISITES，super+FORCE RLS正对照仍ready。最终PG21/21、纯13/13、零会话/业务写入。003保留原owner/ACL，不把重跑迁移当作错误owner的修复。

备份升级链现为001→002→003，任一步失败短路；恢复/回退说明要求保留过滤函数并核对备份后撤权。扩展真实恢复单项1/1：inactive actor/原role和拒绝旧键重放均保留，owner仍可继续v3；首次临时harness的PATH漏掉Docker目录导致pg_dump启动失败，修正PATH后通过，没有修改产品来解释该失败。实际归档36175字节及TAP见本云 `/tmp/ops-membership-restore-fixed-path.tap`，不是用户实际备份。

[8c8e316完整远端CI](https://github.com/chuali-zi/memz/actions/runs/42413990896)成功：core483/483、迁移9/9、Python99/99、产品UI95/95、响应式4/4、真实服务合成adapter12/12、retrieval19/19，以及SQL计划/停机恢复/完整PG UI/材料包后续步骤均通过。远端归档内system `artifacts/system/run-1794085479167-2829fd2c`、UI `artifacts/ui/run-1794085626900-13e95e51`，未作为本机下载路径。相同干净提交在本云默认Node24也通过core483/483、迁移9/9，验证工作树system `artifacts/system/run-1794085224557-086723ec`。

仍继续浏览器已知角色/403后的过时操作入口、在途写入遇到撤权的原子性，以及稳定本机API子集的机器可读合同。未把尚在开发的内容当成已验证或已推送。LoCoMo仍0字节，原Library helper失败阶段及未知网络原因不变；未盲试或绕过。用户已保存的Vault键及覆盖范围是已确认事实；本夜间新增模型调用0，历史351次请求保留原范围。

追加测试阶段：`test/membership-write-revocation-postgres.test.js` 在原生callback确认INSERT成功、真实READ COMMITTED后暂缓交付结果，待限定成员UPDATE的COMMIT完成才继续。两种创建均在后续audit RLS处42501、实际ROLLBACK，8表业务/receipt/history无残留；inactive原键403，明确恢复后只创建一次并准确重放，candidate仍pending无revision。Node24正常2/2、12HTTP、44845字节；原撤权9/9也重跑通过、27HTTP、199141字节。

独立纯故障审查发现并修复两个测试harness清理问题：work计量超限不能再次阻断DROP；CREATE已成功但结果计量失败前须登记owned归属。两个测试文件从原1MiB中预留4KiB给限定ROLLBACK/精确owned DROP，不放宽总量。纯4/4和真实两个小fixture故意预算失败均确认清理；真实故障TAP按预期exit1、2fail，但2created/2dropped，不能把它们计入normal通过。最终正常2+9通过且数据库前缀无残留；不声称验证未知网络CREATE结果的回收。这些是测试基础设施改进，不是新增生产权限或任意在途撤权取消保证。

## 2026-11-07 21:58 UTC 检查点

- d356777：浏览器在清除创建键和进入成功分支前，按实际发送JSON快照核对来源/候选的项目、ID、trim文本、十进制整数引用及pending状态。异常2xx仍属未知，曾未知的同键不因后来403/409释放；fresh4xx与旧响应身份保护保留。独立VM在Node22/24各36/36，Chromium产品111/111、响应式4/4，本云真实PG UI31屏通过；完整CI core534/534及全部后续步骤成功。
- 947b416：审批回执先核对动作状态及expected_version+1/int32版本，再读取刷新和宣称成功；拒绝状态不消费unused版本。异常明确未确认、要求刷新核对，无自动重试或创建键。Node22/24实际app VM各8/8，新增实际Chromium2项先红后绿，完整产品113/113；草稿、caret、旧页、503、409和workspace边界保留。

[947b416完整远端CI](https://github.com/chuali-zi/memz/actions/runs/42416987480)成功：Node22核心542/542、迁移9/9、Python99/99、产品113/113、响应式4/4、真实服务合成adapter12/12、retrieval19/19及所有后续SQL计划/真实停启/UI/包步骤。远端system `artifacts/system/run-1794087730373-881a485a`、UI `artifacts/ui/run-1794087882395-f327dc09`，不冒充本机已下载。相同干净947b416在本云Node24独立通过core542/542、迁移9/9、真实PG UI31屏与合成retrieval19/19；验证工作树system `artifacts/system/run-1794087673039-e4efc148`、UI `artifacts/ui/run-1794087673477-152af19a`，材料包 `artifacts/submission/947b416de6ac-1794087831987-ae6fc3` 均属于该干净提交。

[四项定向引擎突变证据](../evaluation/evidence/selected-core-mutation-2026-11-07/README.md)固定947b416与Node22，先通过选定A2/B2/C1基线，再独立移除过期版本、异参幂等、active过滤及COMMIT回执检查。4项均由真实目标行为断言失败发现，非源码文本、初始化/语法或超时失败；M4只声明第一division分支被发现。63HTTP，原计量175727字节，再加明确重建的终末DROP及最后metadata检查为176857字节，不是heap/wire硬界；计量分量、stale诊断副本与限制均在README/parent-ledger。9个已知自建库确认不存在，独占worktree已移除，4目标源码哈希恢复且main当前干净。原始摘要/全TAP/patch/metrics/脚本均原字节保留，53个文件含校验清单；不将4项选定检查称为全局覆盖率、安全证明或性能实验。

原Space报告已在同一身份更新第5版（21:29UTC检查点），保留11月6日11760字节历史及真实Node配对证据。该版的已确认HEAD为30619f7，后续创建/审批回执阶段另按此处记录，不把旧报告当实时main。LoCoMo仍未取得，外部模型本夜间新增0次，历史351次请求的范围不变；不以工程/检索检查代替回答正确率或token/费用结论。

## 2026-11-07 22:14 UTC 独立材料包首次运行

[947b416材料包烟测](../evaluation/evidence/package-first-run-2026-11-07/README.md)使用293清单文件加manifest，在新scratch内从已知公共缓存独立npm ci（offline/ignore-scripts/empty配置、锁110项且无安装脚本）；4个生产入口realpath均在副本node_modules，未借用上级依赖。正式CLI从foreign cwd启动，三资产hash匹配、canary404，setup/live/ready和22次实际HTTP检查通过：成员来源/候选同键重放、owner显式批准、viewer固定v1完整原文、另一账号403及退出。八表14→23行，source/candidate/fact/revision各+1、audit+3、receipt+2，项目/成员/角色属性不变；SIGTERM正常exit0，无KILL，自建库、客户端/socket/应用副本均清理。

声明范围内work73768+cleanup207=73975字节，不含包/cache文件IO、服务内部PG、wire/heap；1887ms是这个有温缓存的小流程用时，不是安装/启动性能或生产SLO。使用既有PG角色、仅在新随机库去掉一条已存在CREATE ROLE，未验证空集群建角色；HTTP-only，无MCP握手、浏览器或完整542重跑。包无自身.git且设置ceiling，但原gitRepository=false为scope声明而非Git-discovery探针；不从loose包生成Git来源证据。原report schema字段对象碰撞、部分回执仅ID/选定字段而非全字段/字节等价、raw runner只能在专属空scratch布局运行等限制均原样注明。独立复审与原包/manifested字节核验通过；6份原始payload加SHA清单保存，未改原包或原始报告。

CI已另提交91f4735扩为Node22/24相同集成链，每job原15min且fail-fast=false，Python准备仍一次；Node22九个artifact旧名保留，Node24追加-node24，18名预检无冲突。[91f4735真实双版本CI](https://github.com/chuali-zi/memz/actions/runs/42418928725)已成功：test(22)、test(24)及单份Python准备三job均成功；两Node版本各core542/542、迁移9/9、产品113/113、响应式4/4、adapter12/12及所有后续步骤，18个不同名称的artifact上传均确认。CI Node24实际为24.22.2，不能混称本云24.22.1。

## 技术栈决定与主要缺口

目前继续Node/Express/PostgreSQL。现有测量是特定fixture的HTTP传输和真实模型小样本，不是语言/框架横向基准，没有证据说明更换语言能消除主要瓶颈。保留RLS、不可变revision、审批和幂等语义比立即重写更重要。若后续测量显示明确瓶颈，再在固定数据/硬件/并发和冷热条件下比较p50/p95/p99、吞吐、错误率、内存、读写成本；候选栈必须先实现相同接口合同和影子对照，再提供保留数据迁移、备份恢复、回退和分阶段切流方案。

优先待办：自然语言查询规划／历史路由的独立检索评估；服务生命周期与故障恢复；真实身份认证/会话存储方案；更大范围一致性与容量测量。不能把 substring 搜索称作语义检索，也不能因增加可靠性模块声称已经可公开生产部署。

远端已有 2026-11-06 的DeepSeek真实实验与原始usage，见 `benchmarks/memory/DEEPSEEK_RESULTS.md`。本云线程旧报告“模型调用0”只描述当时这一个执行阶段；不能据此否认后来其他会话的351次请求，也不能把原创合成工作负载当LoCoMo。当前本轮未新增收费模型调用；没有读取/打印/提交secret。

## 续做约束

每轮先读本记录、最新用户指令、git status、远端main和CI，确认无人正在写同一文件；保留所有尚未提交变更，不强推。用户允许Sol6.1 High多子智能体并行，代码由主代理审查后提交。测试通过才推送对应代码；明确dirty-run与clean提交证据。故障请求不自动重试写入。剩余时段做有测量/验证价值的实质改进，不空转或制造重复任务。到目标窗口结束时汇总实际提交、远端CI、未完成项和确切阻碍。

## 2026-11-07 22:43 UTC 同页面会话恢复

浏览器现在把完整、当前会话代次的项目401与普通读取失败分开：暂停创建/审批/模拟入口，保留原草稿、已选来源、未知创建原键及既有未确认提示。独立密码表单仅人工重登最初实际接受的username；有效登录回执后仍须重新确认当前项目访问和可写角色。503/403/viewer继续限制写入，旧会话晚到401不能重新锁住新会话；恢复不自动重试业务POST，不抢正在编辑的草稿光标。刷新/关页/切账号仍清内存，没有持久密码或键，也没有新增生产身份提供方。详见[恢复合同](browser-session-recovery.md)。

新窄屏探针先真实复现恢复错误区的长合法文本撑出47250px；复用已有action-feedback换行后，320/390px均恢复到视口宽。新增两项真实Chromium先红后绿，检查label/Tab/Enter、双击单登录、密码清空、BODY焦点恢复及不抢draft caret。另一个中间失败是测试误假定禁用按钮必立即失焦；实际点击非可聚焦标题建立BODY前提后保留正向焦点断言，未改产品掩盖它。最终产品119/119、响应式6/6通过；完整PG页面初版31屏通过，随后仅补该换行并独立回归。

新增独立VM实际app会话代次10项、重启harness私有helper6项，Node22/24各通过；明确最小DOM/五列表替身和mock query，不能冒充真实服务。当前开发树Node22完整core558/558、迁移9/9通过，系统目录 `artifacts/system/run-1794091233022-a1153cd6`。本地为dirty开发回归，期间package只补测试别名，不用它生成正式同提交材料包；提交后完整CI另行核实。

显式 `test:session-recovery` 实际使用随机PG库、真实CLI两进程和同一Chromium文档：提交来源后故意丢已收到200回复，再正常停旧进程、同端口启动新进程，原键真实401后人工同账号重登/重新核权/人工重放。八表指纹和来源/审计/回执各1证实无重复，另一账号真实403。首次Node22旧脚本为30HTTP/89093应用字节；最终脚本031eb87f及新index在Node24为30HTTP/89117字节、1498ms，两进程exit0非forced，六项清理成功、DB目录确认0。最终本地报告 `artifacts/session-recovery/run-1794091216992-409cf72b/report.json` 保留HEAD67b1f29、dirtytrue和13个明确文件hash，未声称整仓库clean或全局源码不变；该小流程耗时不是性能/SLO。

独立审查先发现并修正测试harness失败路径：超cleanup计量不能阻止已知owned DROP，已过deadline不启动操作且执行cancel，cleanup独立最多60s并受总660s约束。常驻mock故障6项通过；另在临时内存注入副本人工耗尽cleanup计数器，实际0HTTP/1库的流程预期exit1/CLEANUP_BYTE_LIMIT，native DROP/同名catalog0及全部关闭成功。该故意失败不计正常通过；原报告/注入元数据保留 `/tmp/memz-session-cleanup-fault/`，没有改写首次green。计量只覆盖声明应用字节，排除wire、服务内部PG、控制协议、文件IO和heap；超量仍记录失败，不把终端清理例外称严格内存硬界。

测试别名与Node22/24 CI显式重启步骤已整合，旧18个artifact名不变，新session-recovery[-node24]共20名唯一。新增[分层测试索引](testing.md)准确区分纯/合成/真实PG/浏览器/备份/材料包/模型；纠正专用测试管理员还需管理随机角色，清理以实测记录为准，不要求重置已有业务库。上一67b1f29完整双版本CI已成功；本轮提交及其远端结果待下一记录。真实模型新增0、LoCoMo仍无字节，22:34只读实例观测仍无合理GLM变量名/绑定，Vault已保存事实不变，最新草稿发布及下载服务恢复仍unknown。


## 2026-11-07 22:49 UTC API缓存边界

[6fc013d完整双版本CI](https://github.com/chuali-zi/memz/actions/runs/42421924037)已成功：Node22/24各core558/558、迁移9/9、产品119/119、响应式6/6、真实服务合成adapter12/12，新增真实同页面CLI重启各30HTTP/89117应用字节且清理全成功；Python离线99/99及检索/计划/停机/UI/材料包全部后续步骤通过。20个独立artifact确认上传。远端Node22 system `artifacts/system/run-1794091485658-32f34e67`、UI `artifacts/ui/run-1794091632794-fd60050c`；Node24 system `artifacts/system/run-1794091502868-77b88186`、UI `artifacts/ui/run-1794091638686-c07ae33e`，不是已下载本机目录。

独立原生Chromium探针发现API响应可进入HTTP缓存：退出、换账号和合成撤权后，显式force-cache能0次服务端请求重用旧owner正文；现有UI默认fetch对照仍到达服务端并正确401/新账号/403，未证明默认UI已泄漏。现仅在API挂载最前设置no-store，先于Host、JSON、停机和会话闩；不改认证/项目权限、全局ETag或静态策略，不声称追溯清旧条目、BFCache、页面内存或任意外部代理行为。

新opt-in `test:http-cache` 以实际Express/session/login/me/projects/facts、明确fake pool与真正loopback/Chromium原生缓存验证，不用Playwright route（它会禁HTTP cache）。正式先红18HTTP/5067正文bytes，4个目标断言失败、其余10个对照通过；修复后Node22/24各14/14、23HTTP/5321正文bytes、25次fake SQL/真实PG和模型0，所有浏览器/服务/socket/pool清理成功。报告只计数/身份匹配布尔值，不保存cookie/CSRF/正文原值；四个明确源码hash前后相等。原始red与两green在 `/tmp/memz-http-cache-regression-{red-6fc013d,green-node22-09df1f8,green-node24-09df1f8}/report.json`，不把scope hash称整仓库attestation。

既有request-body/actual-health用例顺带检查API 400/413/415/401/403/404、Host优先和大小写GET/HEAD的drain503均no-store；健康探针无ETag语义保留。Node22/24各17/17；consumer合同/DB错误/headers后日志相关各24/24也通过。没有增加镜像helper或新的生产故障接口。独立脚本24HTTP/512KiB、4min work+1min cleanup；字节非wire/heap硬界。两个CI job显式运行并上传http-cache[-node24]，旧20个名保留、共22名唯一；配置不等于远端已过。本轮正式提交/CI在后续核实，所有模型和LoCoMo限制不变。详见[缓存边界](http-cache.md)。

## 2026-11-07 23:12 UTC 观测回归与未开始HTTP的连接排空

b0afaa0的[双版本CI](https://github.com/chuali-zi/memz/actions/runs/42422401845)整体失败，不能写成全绿。两个Node的API原生缓存对照均通过（CI各22HTTP/5171正文bytes，favicon调度与本机23次不同），core558/558、迁移9/9和Python99/99通过；重启测试在初始11HTTP读取时旁路body观测失败，后续依赖步骤未运行，部分always上传因无产物另报错。root在干净b0af本地复现相同失败，原始report保留；同提交本地system/UI/retrieval/材料包验证虽通过，也不能替代失败的完整CI。

限定诊断将错误准确分类为CDP_DATA_UNAVAILABLE（调试协议报告无资源数据），发生在不同初始API；页面实际接受owner和五列表。独立13HTTP小探针未复现，故不推断no-store普遍导致正文不可读。测试改用原有Playwright拦截路径逐请求执行一次真实route.fetch，禁止自动重试/重定向，计量实际完整上游正文后原状态/头/正文交付页面；丢回复仍只在真实200后abort，缺正文和3xx继续失败，不忽略错误/补发业务请求。它是测试代理转发，不冒充原生浏览器缓存行为；原生缓存另有独立回归。安全固定failure/stage进入stdout，首错保留，清理分阶段继续而不因观测错跳过context/browser关闭。常驻actual-helper由6扩为11项，Node22/24各11/11，真实PG/HTTP/模型0。

新转发路径又暴露实际CLI停机缺口：独立actualNode24 CLI、lazy DB端口1、一个空TCP加live200屏障（至多2连接）在SIGTERM后等20008ms而exit1，非强制kill。该无PG红证据在 `/tmp/memz-bare-tcp-drain-report.json`，不是测试代理必然故障。生命周期现在在app处理前按socket跟踪未完成HTTP响应，finish/close只结算一次；开始排空时关闭无完整HTTP头的连接，保留已开始HTTP的慢body/活动响应和流水线，响应全部完成后end发送队列，不破坏pool顺序/重复信号/原20秒总期限。导入app不安装跟踪或信号。

新增原生回归在Node22/24各2/2：actualCLI空TCP+部分头+live屏障最多3socket、无session/checkout，约4ms正常退出；受控原生HTTP fixture在关闭空连接时，524321字节长200与排队503均完整、pool在两响应finish后仅end一次。新用例落地时产品已修，先红依据是上述独立旧版20.008s探针；不伪造新test的baseline。旧生命周期/启动/运行时错误13/13 Node24通过，两个真实20秒hang分支保留；原慢body测试和真实PG锁等待将在完整core继续检查。

最终本地Node24真实HTTP/PG重启回归通过：30HTTP、89117声明应用字节、1678ms；两PID同端口、SIGTERM各exit0、无KILL/stderr，source/audit/receipt仍各1，八表指纹/原键/草稿/选择/同页/新cookie与CSRF/人工重新核权及另一账号403全部保持，0观测错误，独立清理全成功。报告 `artifacts/session-recovery/run-1794093044713-2b686026/report.json` 如实记录HEAD b0af+dirtytrue及明确源码hash；不是clean提交或性能承诺。原失败报告未改，完整CI待本轮提交后核实。

首次新集群扩展仍只是未提交草稿，没有启动Docker或PG；独立审查先指出精确资源名归属及命令总期限问题，未修好不执行，不计入当前成果。本轮优先把实证停机缺口及CI回归闭环。新增模型仍0，LoCoMo字节仍0。

## 2026-11-07 23:40 UTC 首次安装与页面取证收尾

11129b2的[CI](https://github.com/chuali-zi/memz/actions/runs/42424311659)为Node22完整成功、Python成功，Node24在旧UI取证的无界等待达到job期限而cancelled；不能合称全绿。其core565/迁移9、单次真实重启及此前故障修复结果仍有效，完整状态按run/job区分。干净11129本地Node24系统也通过565/565、9/9，system `artifacts/system/run-1794093275578-e15b3ad6`（在 `/workspace/memz-verify`）。

旧UI在本地卡到第16图后，终止本次唯一owned进程后原wrapper写失败并完成finally，临时库目录确认0；/proc cwd读取因权限拒绝而未重试，不借其他接口获取该目录。新增有界控制先在真实PG明确报old history body阶段超时，没有把它当通过；当前4个迟到读取改为动作前登记一次性原api invocation，原HTTP/UTF8/JSON完整消费成功后才继续旧代次/页面断言，不依赖CDP旁路finished、不补发请求。原返回值/error identity透明，141个业务断言及2帧状态检查保留。

UI controller工作120s、stage15s、独立浏览器cleanup12s，所有held释放、取消后不发新业务动作，失败及清理状态最后写报告。wrapper的自有server在runUI结束后关闭所有fixture sockets，分页准备每轮检查取消signal，不声称撤销已发事务。常驻纯controller4项在Node22/24各通过，无Chrome/HTTP/PG/模型；真实Chromium共享harness各正常+三故障均按预期，原api消费探针各正常+四坏body/403均正确失败且每case仅一GET。第二次真正PG UI已通过，31屏，目录 `artifacts/ui/run-1794094692337-b36b11e1`；这是dirty开发树回归，不拼为clean材料包。提交后CI另行核实。

新增显式first-run-cluster验收已有两次真实、独立清理的记录，见[原字节归档](../evaluation/evidence/fresh-cluster-first-run-2026-11-07/README.md)。首次干净f902040 internal草稿在端口条件处失败，0HTTP/6843bytes/5662ms，未到doctor/应用阶段。专属普通bridge恢复原Compose连接方式后，干净1d630fa一次通过47HTTP（44×200、2×403、1×409）、17264声明bytes=14758work+2506cleanup、HTTP正文7450bytes、7042ms。原schema8005bytes/CREATEROLE完整，额外只读observer实测建角色前0，app角色及4active成员正确；doctor/live/ready、原context20v1与原demo七步15v2/旧20v1/409/两403全通过，八表14→41行，CLI正常退出、标签+精确标识双查全清。未下载镜像、未外网探测，使用已有锁定依赖链接和缓存镜像，非空机npm安装、未改Compose原样执行、生产认证或性能SLO；普通bridge并非egress隔离。此opt-in不进默认core/CI，不把静态配置当每轮真实执行。

本轮待推送合入first-run两个本地提交与UI/证据归档。模型本夜间新增0，LoCoMo0字节；原历史351请求不改。新云仍为唯一执行环境，同一Library报告将保留完整历史更新终态，最终CI及材料包按最新实际结果记录。
