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

当前继续推进：CLI有界优雅退出；5列表合法JSON但不合法字段/游标回执的提交前验证；每轮完整CI与新源码依赖的材料包验证。尚未结束用户要求的夜间窗口，继续按实质改进推进，避免重复创建任务。

## 技术栈决定与主要缺口

目前继续Node/Express/PostgreSQL。现有测量是特定fixture的HTTP传输和真实模型小样本，不是语言/框架横向基准，没有证据说明更换语言能消除主要瓶颈。保留RLS、不可变revision、审批和幂等语义比立即重写更重要。若后续测量显示明确瓶颈，再在固定数据/硬件/并发和冷热条件下比较p50/p95/p99、吞吐、错误率、内存、读写成本；候选栈必须先实现相同接口合同和影子对照，再提供保留数据迁移、备份恢复、回退和分阶段切流方案。

优先待办：自然语言查询规划／历史路由的独立检索评估；服务生命周期与故障恢复；真实身份认证/会话存储方案；更大范围一致性与容量测量。不能把 substring 搜索称作语义检索，也不能因增加可靠性模块声称已经可公开生产部署。

远端已有 2026-11-06 的DeepSeek真实实验与原始usage，见 `benchmarks/memory/DEEPSEEK_RESULTS.md`。本云线程旧报告“模型调用0”只描述当时这一个执行阶段；不能据此否认后来其他会话的351次请求，也不能把原创合成工作负载当LoCoMo。当前本轮未新增收费模型调用；没有读取/打印/提交secret。

## 续做约束

每轮先读本记录、最新用户指令、git status、远端main和CI，确认无人正在写同一文件；保留所有尚未提交变更，不强推。用户允许Sol6.1 High多子智能体并行，代码由主代理审查后提交。测试通过才推送对应代码；明确dirty-run与clean提交证据。故障请求不自动重试写入。剩余时段做有测量/验证价值的实质改进，不空转或制造重复任务。到目标窗口结束时汇总实际提交、远端CI、未完成项和确切阻碍。
