# CVE 模块状态

核对日期：2026-11-08（Asia/Shanghai）。入口与操作说明见 [README.md](README.md)。

## 已实现

- 独立 PostgreSQL `cve` schema 与幂等事务迁移；原 Memz 项目表、审批/修订/权限和网页入口未接入 CVE 写路径。
- CVE JSON 5.x（CNA+ADP）、NVD 2.0、GHSA/OSV、KEV 和可识别 CVE5/NVD 形状的 CIRCL 规范化；保存原始 JSON、来源标识、更新时间、抓取时间、内容 hash。
- 独立来源当前指针与追加 observation，重复导入去重、旧更新时间拒收、CVE REJECTED 默认排除、GHSA alias 移除水位、KEV membership 移出与历史保留。
- 本地 JSON 文件/目录导入；固定 Git commit 的全量首次扫描和后续 diff；NVD 有界窗口、限流/重试、每页事务断点与失败恢复；可选 KEV 全快照/CIRCL 单条补查。
- CVE-ID、厂商/产品、包生态、CWE、完整 CPE、KEV 与英文词项检索，CVE-ID 游标分页；参数化 SQL、只读事务、来源摘要及完整 observation 回查。
- 独立本机 HTTP API、Node 客户端、`cve_read_context` MCP stdio 工具；明确的候选/版本未判定语义、输出预算、无命中和错误状态。
- 原创合成 fixture、真实 PostgreSQL/HTTP/MCP 回归、16个合成检索预期用例与独立 Node22/24+PG16 CI 配置。

## 实际验证

本机 Node **v22.23.4 / v24.22.2 / v25.6.1**、PostgreSQL **16.15**（本机现有 PG16 容器）。三个 Node 版本分别执行相同回归，各20/20通过。Node22/24通过 npm cache 中独立运行时执行，没有更换系统 Node 或修改项目依赖。所有数据库检查在显式测试管理员连接创建的随机临时库执行，并清理临时库/角色；没有在现有 Memz 数据库执行本模块迁移或导入。

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| 单元 + PG/HTTP/MCP 回归 | **Node22/24/25各20/20通过，0失败，0跳过**；包括并发更新、Git 删除拒绝、输出预算和断点不允许跳窗 | `node --test cve/test/*.test.js`；[Node22 TAP](evidence/tests-node22-2026-11-08.tap)、[Node24 TAP](evidence/tests-node24-2026-11-08.tap)、[Node25 TAP](evidence/tests-node25-2026-11-08.tap) |
| 合成候选集合评测 | **16/16 通过**；3条合成 CVE、6条来源记录，含无命中/撤回/跨产品不匹配/未评估版本 | `artifacts/cve/evaluation.json`，`node scripts/cve_evaluate.js` |
| 真实公开来源联网 smoke | **5/5 来源成功**；CVE Program、NVD、GHSA、KEV、CIRCL 各导入同一已知 CVE 的一条记录 | `artifacts/cve/live-smoke.json`，`node scripts/cve_live_smoke.js --allow-network` |
| 真实记录上下文大小 | `CVE-2021-44228`，**5个来源引用，15,575 bytes**，小于64KiB预算 | 联网 smoke 报告，不含第三方原文 |
| 原 Memz 全量测试 | **未运行**；本模块独立，原仓库有既存未提交变更，且其完整套件需要额外隔离/种子前提 | 本轮仅运行与新增 CVE 模块相称的检查 |
| GitHub CVE CI | **success**，实现提交 `87a381b` 的 Node22/24 两组检查均通过 | [实际运行42495382499](https://github.com/chuali-zi/memz/actions/runs/42495382499)，`.github/workflows/cve.yml` |

复跑生成TAP时曾出现一次临时库清理阶段的异步连接错误，退出码1；没有将该次报告作为通过证据。原因是 `pg-pool.end()` 与 idle socket 实际关闭存在时序差异。已让测试清理等待各连接的 `end` 事件，并去掉强制删库；表中的通过结果对应修复后重新运行的报告。

联网 smoke 抓取的固定上游提交：

- cvelistV5：`eb6ee303699384fcf39a3ba036045f3af7ed8f92`
- GitHub Advisory Database：`01ec58531afd348d4b06ae0c9c8487d539e27693`

运行生成报告位于 Git 忽略的 `artifacts/cve/`，可按命令重新生成。本次已核实的脱敏报告另保存于 [evidence/](evidence/README.md) 供提交后回查。联网只下载公开资料；报告记录 URL/hash/状态，原始 JSON 只进入临时库，未纳入提交。KEV 下载完整 feed 以核实格式，实际仅选择 smoke CVE 入临时库。

## 边界与未完成项

1. **没有持久全量 CVE 库，也未进行生产部署。** 已提供全量/增量入口；本次真实联网验证只有一个 CVE 的五个来源。未把下载成功解释为上游全历史完整、实时同步或全库性能通过。
2. **没有 embedding 或模型生成链。** 当前是结构化 + PostgreSQL 全文候选检索和带引用的上下文输出；合成16题不证明真实语义检索/模型效果。中文分词、同义词和相关度重排未实现。
3. **没有通用版本受影响判定器。** `version` 只携带查询上下文，显式标记需生态专用评估；完整 CPE 条件和各类版本区间原样回查，不根据字符串大小比较或向量相似度给安全结论。
4. **未修改/联调 pentest-tools。** 只读核对了 `D:\projects2\pentest-tools` 当前 TypeScript 工作台的资料与工具入口，并提供 HTTP/Node/MCP 契约。未注册到其 agent、未跑真实渗透任务、未把检索候选变成自动执行动作。
5. **未修改 `D:\race\sql`。** 本轮代码和文档全部位于 Memz 仓库。
6. Git 大快照的首次逐文件读取、NVD 大规模回填、跨来源覆盖率、恢复演练和长期调度需要单独验收。上游删除/历史断裂显式停止；没有自动丢数据的修复命令。独立 HTTP 服务仅用于本机公开资料读取。

## 本次 Git 范围与同步

起始分支 `main`，起始 HEAD `ee1f1f21ad29fa9a93011b31fd50759dd88f52b7`，已有远端 `origin=https://github.com/chuali-zi/memz.git`，起始远端 `main` 与本地 HEAD 一致。已有大量 Memz 改动未提交；本任务只暂存新增 `cve/`、`db/cve_schema.sql`、`scripts/cve_*` 和 `.github/workflows/cve.yml`，不撤销或混入原改动。

实现提交：`87a381b6affe336f4f807ae697cb1ea5ee9074e5`（`Add isolated CVE knowledge ingestion and read-only retrieval`）。已成功推送到已有 `origin/main`，并通过 `git ls-remote` 确认远端 SHA 与该实现提交一致；该提交的 CVE CI 已核实为 success。原有工作区改动与起始状态一致，暂存区为空，临时测试库/角色已清理，原 Memz 库中未创建 `cve` schema。

本文件随后仅补记上述已发生的提交、推送与 CI 结果；补记提交自身的 SHA 见最终交付与 Git 日志。推送仅面向已有 `origin/main`，不改身份、不 force push、不夹带额外已有提交。
