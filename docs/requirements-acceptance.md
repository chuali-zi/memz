# 需求—验收—证据对应表

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
| R12 保留数据升级 | 原库升级后业务行/序列/权限/策略不变；可重复；失败回滚；应用账号不能迁移 | 001迁移 | test/migrations.js 7组；含升级后完整HTTP集成 |
| R13 输入错误可理解 | 登录/来源/候选要求JSON对象；非JSON415；空/坏JSON400；超16KiB413；错误JSON不反射请求原文 | requireJsonObject、解析器、统一错误处理 | request-body.test.js 8组，含字节边界、多字节与gzip膨胀、错误安全头 |
| R14 演示可复现 | 无需重置现有数据生成八张截图；报告含提交/版本/校验值；没有浏览器脚本错误 | test/ui.js、ui-evidence.js | ui-evidence artifact；docs/demo-evidence.md |

## 运行条件与取证方法

- `npm test`：初始种子的测试数据库；包含数据库集成和请求体测试。请求体测试对连接池设置拒绝访问哨兵，验证这些拒绝路径不触及数据库。
- `npm run test:migrations`：显式测试管理员连接，只创建/删除随机临时库；验证升级及保留数据。
- `npm run eval:retrieval`：显式测试管理员连接，固定207条当前事实，保存原始HTTP耗时。正确性是硬条件，耗时不设跨环境门槛。
- `npm run test:ui:evidence`：显式测试管理员连接及Chromium，在临时库运行真实页面交互，生成截图与report.json。

连接变量与命令见README及各专门文档。最终材料应记录提交SHA、CI链接、运行环境、预期与实际结果；截图采用对应artifact的原始文件，并保留报告校验值。失败截图只能作为缺陷/排查证据，不能用于宣称流程通过。

## 目前不覆盖的需求

没有真实账号体系、组织级密钥管理、持久化会话、真实智能体/文档导入、语义检索、并发负载容量结论、正式可用性研究或生产安全审计。接口没有分页、创建请求幂等键；重复提议可能创建多个候选。管理员/应用数据库凭据泄漏不在RLS身份假设的保护范围内。原通知模板、最终材料格式和提交渠道仍需复核。
