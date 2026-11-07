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

最新完整远端成功检查点：[1cea35a CI](https://github.com/chuali-zi/memz/actions/runs/42387954090)。本地同提交干净Node24工作树core202/202、migrations9/9、完整真实数据库UI通过；system目录 `artifacts/system/run-1794066385049-61a50bb9`，UI `artifacts/ui/run-1794066386698-3994a7ac`（均在验证工作树）。没有以局部测试代替该提交的整套结果。

保留一项未归因的历史风险：[e038e74 CI](https://github.com/chuali-zi/memz/actions/runs/42386605465)为core174/175、migrations9/9；GitHub工具可解析产物身份，但当前消费端下载和受支持物化均未取得可读字节，网络原因未确定。未换执行器或改网络规则，未盲重跑旧CI。按该CI日志匹配并校验官方SHA的Node22.23.4，在同一云环境对同一e038e74干净工作树独立复现175/175+9/9通过（`artifacts/system/run-1794066777587-41e64f4d`）；因此暂未复现，不能称旧失败已归因/修复。Node22仅位于workspace临时toolchain，未替换默认Node24。

## 当前精确读取路径检查点

- 3a99b67：v2纯协议、完整标签校验及精确selector模板planner，共享证据校验机械提取，74项回归通过；原v1模板与header行为保持兼容。[该提交完整CI成功](https://github.com/chuali-zi/memz/actions/runs/42389424095)。
- 8a0e487：要求Node22+，与当前CI和官方仍受支持LTS保持一致；仅修改engines及锁文件根元数据，没有升级依赖或替换云默认运行时。
- fc4b294：独立的授权current-labels与context/exact HTTP路径。标签只读取subject/predicate、不读取value/source，最多512个完整标签；513个返回complete:false与空标签。精确读取在单个事务快照内校验current revision、已批准candidate、source和scope，损坏数据报错，不降级为空结果。POST只读错误与写入不确定错误分开，原/context合同未改。

fc4b294的新增HTTP5项、独立真实PostgreSQL8项通过，覆盖256/512/513、字面量特殊字符、权限/RLS、并发版本、坏指针及来源/正文超限；这是合成数据的真实服务验证，不是模型或LoCoMo评测。[完整远端CI成功](https://github.com/chuali-zi/memz/actions/runs/42390931415)。同一云环境的干净固定提交、Node22.23.4独立system core230/230与migrations9/9通过，目录 `artifacts/system/run-1794068716022-35be8691`（验证工作树）。

当前继续实现显式opt-in的v2 CLI：默认v1继续最多25标签；新模式最多512完整标签且精确键读取，元数据与精确读取分别是current事务，不能声称两次请求共享冻结快照。该CLI尚未交付，不能把HTTP已验证当成CLI已验证。另并行检查界面可恢复操作、运维故障和MCP只读接入边界。继续夜间窗口内的实质工作，遵守用户后续停止/变更指令。

## 技术栈决定与主要缺口

目前继续Node/Express/PostgreSQL。现有测量是特定fixture的HTTP传输和真实模型小样本，不是语言/框架横向基准，没有证据说明更换语言能消除主要瓶颈。保留RLS、不可变revision、审批和幂等语义比立即重写更重要。若后续测量显示明确瓶颈，再在固定数据/硬件/并发和冷热条件下比较p50/p95/p99、吞吐、错误率、内存、读写成本；候选栈必须先实现相同接口合同和影子对照，再提供保留数据迁移、备份恢复、回退和分阶段切流方案。

优先待办：自然语言查询规划／历史路由的独立检索评估；服务生命周期与故障恢复；真实身份认证/会话存储方案；更大范围一致性与容量测量。不能把 substring 搜索称作语义检索，也不能因增加可靠性模块声称已经可公开生产部署。

远端已有 2026-11-06 的DeepSeek真实实验与原始usage，见 `benchmarks/memory/DEEPSEEK_RESULTS.md`。本云线程旧报告“模型调用0”只描述当时这一个执行阶段；不能据此否认后来其他会话的351次请求，也不能把原创合成工作负载当LoCoMo。当前本轮未新增收费模型调用；没有读取/打印/提交secret。

## 续做约束

每轮先读本记录、最新用户指令、git status、远端main和CI，确认无人正在写同一文件；保留所有尚未提交变更，不强推。用户允许Sol6.1 High多子智能体并行，代码由主代理审查后提交。测试通过才推送对应代码；明确dirty-run与clean提交证据。故障请求不自动重试写入。剩余时段做有测量/验证价值的实质改进，不空转或制造重复任务。到目标窗口结束时汇总实际提交、远端CI、未完成项和确切阻碍。
