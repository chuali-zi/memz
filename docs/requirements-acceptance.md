# 需求—验收—证据对应表

> 本表记录旧项目记忆原型的验收。2026-11-09 起的产品需求与验收以 [智能体漏洞知识库需求](cve-product-direction.md) 和 [CVE 状态](../cve/STATUS.md) 为准，不能用本表的审批或记忆成绩替代漏洞检索验收。

下列R编号是本项目内部需求编号，不是赛事评分项或官方权重。测试使用合成数据；“证据”指对应代码与可复现流程，最终引用时须附同一提交的CI结果与artifact，不能把未来运行写成已通过。

| 需求 | 可执行验收条件 | 实现位置 | 自动证据与演示材料 |
| --- | --- | --- | --- |
| R01 会话身份可信 | 伪造X-User不能登录；错误密码/非字符串用户名401；退出后旧cookie失效 | server.js 登录、会话中间件 | integration.test.js伪造身份；request-body.test.js退出失效；UI 01/02 |
| R02 项目隔离 | 用户不能读另一项目；来源不能跨项目关联 | memberships、member_role、RLS与复合外键 | integration.test.js跨项目请求/SQL；检索隔离用例；UI 08 |
| R03 角色分工 | owner/member可提议；viewer不能写；只有owner可决策 | role检查与各表写入策略 | integration.test.js权限与操作前后快照；UI 07 |
| R04 来源与候选先于事实 | 提议只产生pending候选及propose审计，不自动改变当前事实 | candidates接口、sources接口 | 检索待审排除用例；UI 05 |
| R05 审批形成可追溯历史 | 批准后version+1；旧值/来源保留；同一候选不生成两条修订 | decide、revisions唯一键、facts指针 | integration.test.js重复审批/版本；UI 03 |
| R06 冲突不覆盖 | 两个相同expected_version候选并发审批只有一个成功，另一409；首次创建也如此 | 候选行锁、事实键advisory lock、版本比较 | integration.test.js已有/新事实并发；UI 04 |
| R07 失败原子性 | 插入修订后注入异常，事实版本、候选状态、修订和审计整体回滚 | tx与decide事务 | integration.test.js injected failure断言 |
| R08 读取一致 | 同一响应中的事实、候选、历史、审计属于同一快照 | readProject只读REPEATABLE READ | integration.test.js插入并发写入的确定性快照测试 |
| R09 当前事实检索 | 中文/大小写/字面符号正确匹配；旧版/待审/驳回不进facts；来源正文不作为facts查询范围 | readProject参数化position查询 | evaluation/retrieval-cases.json 19用例；retrieval-evaluation artifact |
| R10 不可信文本不自动执行 | 外部指令只作为数据/候选；负责人可驳回，历史不增加 | 前端textContent、候选流程 | integration.test.js文字检索；UI 05/06；不等于完整XSS安全认证 |
| R11 数据库指针完整性 | 错事实、错版本、正版本空指针均被数据库拒绝 | facts复合FK与CHECK | integration.test.js直接SQL反例；test/migrations.js |
| R12 保留数据升级 | 原库升级后业务行/序列/权限/策略不变；可重复；失败回滚；应用账号不能迁移 | 001/002迁移 | test/migrations.js 9组；含升级后完整HTTP集成 |
| R13 输入错误可理解 | 登录/来源/候选要求JSON对象；非JSON415；空/坏JSON400；超16KiB413；错误JSON不反射请求原文 | requireJsonObject、解析器、统一错误处理 | request-body.test.js 8组，含字节边界、多字节与gzip膨胀、错误安全头 |
| R14 演示可复现 | 无需重置现有数据生成三十一张截图（独立库流程）；报告含提交/版本/校验值；没有浏览器脚本错误 | test/ui.js、ui-evidence.js | ui-evidence artifact；docs/demo-evidence.md |
| R15 创建请求可安全重试 | 同范围同键同内容只创建一次业务/审计；异内容409；失败回滚后可重试 | idempotency.js、回执表与RLS | test/idempotency.js五组，在新库/升级库各运行一次；pg_locks等待观察；客户端三组竞态及真实浏览器丢失响应回归 |
| R16 有界事实读取 | 每页最多100条；游标遍历无重复；保持当前版本及成员隔离 | GET /facts | test/pagination.js十五组；19例双接口检索验证 |
| R17 页面分页可靠性 | 页码/空结果/错误可理解；忽略旧响应；键盘翻页；并发变更后可刷新核对 | loadFacts、请求代次与游标栈 | UI真实临时库56条事实；截图09–12及错误/延迟注入 |
| R18 历史有界读取 | 页面25条；完整遍历与旧历史一致；新增修订不推移较旧页；独立失败恢复 | GET /history、include_history、loadHistory | test/pagination.js；UI截图13–14；contextScale响应测量 |
| R19 候选有界读取与筛选 | 四种筛选完整遍历；审批保持筛选；并发决定仅一次成功且旧页面刷新 | GET /candidates、include_candidates、loadCandidates | 数据库及UI回归；截图15–17；candidateScale实测 |
| R20 来源有界读取与依据保持 | 标题检索及分页；跨页保留来源ID；候选/事实/修订引用一致；新来源明确选中 | GET /sources、include_sources、loadSources、selectedSource | 数据库与UI回归；截图18–20；sourceScale增长测量 |
| R21 材料与代码同提交 | 拒绝脏/过期/失败报告、缺图、校验值变化及实际检索值矛盾；离线校验文件集合；明确合成与CI边界 | scripts/package-evidence.js | evidence.test.js反例与完整包回归；competition-evidence artifact |
| R22 初次加载可恢复 | 项目列表503后刷新可恢复；空项目有明确提示；无项目时不发送null/0项目请求；晚到失败不覆盖新结果 | loadProjects代次保护、load的初始化分支、各列表空项目守卫 | UI真实登录与明确503/空列表/延迟响应注入，report.checks.projectRecovery |
| R23 按版本精确溯源 | 同名来源可区分；指定版本返回旧原文；按需读取与失败重试；成员隔离 | GET /facts/:id/provenance、renderFact | HTTP集成同名来源/版本推进/权限/参数回归；UI 02/03与checks.provenance |
| R24 接入方完整读取 | 一页有界事实与固定版本依据一致；失败不输出部分上下文；标明截断；可选最终UTF-8字节预算保留完整依据；after续读不重复旧ID并明确跨页快照限制；注销会话 | scripts/context-client.js | 真实HTTP并发审批/权限/失败回归、context-client.test.js、context-process.test.js、context-budget.js与context-scenarios.js（105版本、跨项目同名事实及过期冲突） |
| R25 备份可恢复 | 自定义格式备份恢复后数据、序列、约束、RLS、幂等回执保留；可继续批准；损坏归档失败 | pg_dump/pg_restore与既有HTTP接口 | test/restore.test.js真实随机库及子进程；系统TAP原始记录 |
| R26 可复现完整演示 | 从来源到批准上下文、冲突、驳回、历史依据和权限形成真实独立进程故事；材料记录来自TAP | scripts/demo-story.js | integration.test.js初始/升级数据库进程回归；evidence/demo-story.json与.md离线一致性校验 |

## 运行条件与取证方法

- `npm run test:system:evidence`：推荐入口，显式管理员连接，随机临时库执行核心与迁移测试并保留TAP，不重置已有演示数据。
- `npm test`：初始种子的测试数据库及显式MIGRATION_TEST_DATABASE_URL管理员连接、PostgreSQL工具；包含数据库集成、恢复和请求体测试。请求体测试对连接池设置拒绝访问哨兵，验证这些拒绝路径不触及数据库。
- `npm run test:migrations`：显式测试管理员连接，只创建/删除随机临时库；验证升级及保留数据。
- `npm run eval:retrieval`：显式测试管理员连接，固定207条当前事实，保存原始HTTP耗时。正确性是硬条件，耗时不设跨环境门槛。
- `npm run test:ui:evidence`：显式测试管理员连接及Chromium，在临时库运行真实页面交互，生成截图与report.json。

连接变量与命令见README及各专门文档。最终材料应记录提交SHA、CI链接、运行环境、预期与实际结果；截图采用对应artifact的原始文件，并保留报告校验值。失败截图只能作为缺陷/排查证据，不能用于宣称流程通过。

## 目前不覆盖的需求

没有真实账号体系、组织级密钥管理、持久化会话、真实智能体/文档导入、语义检索、并发负载容量结论、正式可用性研究或生产安全审计。页面五类列表已分页，原聚合默认响应仍全量返回；来源/候选支持可选幂等键，无键或不同键重复提议仍可能创建多个候选。管理员/应用数据库凭据泄漏不在RLS身份假设的保护范围内。原通知模板、最终材料格式和提交渠道仍需复核。

材料汇总入口：[六项初赛草稿](submission-report.md)、[演示步骤](demo-script.md)、[同提交打包与真实性边界](evidence-package.md)。
