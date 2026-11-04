# 同提交证据校验与离线材料包

## 目的与真实范围

比赛要求六项文档及必要截图。已有设计文档和20图来自不同开发阶段，不能直接混成“当前版本已通过”的材料。打包器要求浏览器报告与检索报告都来自同一干净Git提交，核对当前源码、截图及检索用例，再生成可离线复核的目录。它解决证据一致性与可复现性，不证明人工输入文本的外部真实性。

## 生成

先提交所有改动，确认git status干净，再在该提交取证：

```sh
EVALUATION_DATABASE_URL=postgres://postgres:postgres_demo_only@127.0.0.1:5432/memz npm run eval:retrieval
UI_TEST_DATABASE_URL=postgres://postgres:postgres_demo_only@127.0.0.1:5432/memz CHROMIUM_PATH=/usr/bin/chromium npm run test:ui:evidence
npm run evidence:package
```

仅使用测试管理员连接；取证创建并删除随机临时库，打包本身离线且不连数据库。不设置CHROMIUM_PATH时使用已安装的Playwright浏览器。默认选择最近修改的UI报告；可通过UI_REPORT_PATH显式指定报告路径。不会静默跳过最新失败报告去挑旧的成功结果。

输出artifacts/submission/提交前12位-时间-随机值/，不覆盖旧包。先完整校验再创建目录；构建中失败只删除自己创建的临时目录。包包含index.md、六项材料草稿与演示步骤、提交中允许的源码/文档、20张PNG、原始报告和manifest.json。不会复制node_modules、备份、.env、运行数据库或任意工作区文件。

CI在真实UI成功后执行打包，上传competition-evidence artifact。打包发生在workflow结束之前，所以清单固定记录ciConclusion为not-verified-by-packager；必须独立核实整次CI终态，不能将有材料包视作CI已成功。

## 拒绝条件与离线核验

校验包括报告schema、synthetic标识、提交和脏状态、源码哈希覆盖、20个指定PNG及SHA-256、浏览器错误为空、19个用例身份与状态一致、报告预期值和实际值逐项匹配版本化黄金数据、分页结果数量、客户端幂等竞态计数以及规模字段存在。缺图、重复图、非法路径、符号链接、失败报告、过期提交或文件变化都会拒绝。

解包后在包根目录执行（仅需Node，无需安装依赖）：

```sh
node scripts/package-evidence.js verify .
```

核验文件集合、所有清单哈希、必要材料及报告与包内源码的一致性。manifest不包含自身哈希；它是文件完整性清单，不是数字签名。攻击者同时改写文件和清单/报告可能伪造一致性，仍需通过独立Git提交、CI来源和人工复核建立信任，不能称为“防伪认证”。

十组独立单元验证与反例验证过期/脏报告、失败结果、浏览器异常、缺图/重复图、路径/符号链接、改动图片/代码/文档、重复检索用例及额外文件；另验证完整构建、离线核验和忽略文件排除。单元测试使用明确的人工fixture，不作为浏览器或比赛证据。真实材料包须另外用同提交实际取证生成并验证。

官方通知原文和模板尚未归档，本文不保证最终格式已满足全部提交细则。打包不报名、不外联、不上传作品到赛事渠道。

独立复核曾确认旧校验器只检查passed标记与状态时，会接受实际值不一致的报告。现以版本化数据集中明确的seed/isolated事实和填充规则重新构造黄金元组；报告actual、expected和分页数量必须一致，不能只相信passed=true。该检查仍不等于外部来源真实性认证。
