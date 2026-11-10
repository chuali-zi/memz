# 持久全量主库与托管同步验证证据

实现与核对跨2026-11-09～10（Asia/Shanghai）；目录日期按本轮开始日保留。当前产品入口与最终运行状态见 [CVE状态](../../STATUS.md)、[CVE README](../../README.md)、[持久运行说明](../../../docs/cve-persistent-runtime.md)。测试与评测报告只包含原创合成资料、测试结果和测量数据；真实全量/增量结果仅保留状态、commit、数量、时间与清单hash等元数据，不包含数据库口令、缓存或第三方漏洞原文。

## 已归档的工程回归与合成报告

| 文件 | 实际结果与范围 |
| --- | --- |
| [tests-node22.tap](tests-node22.tap) | Node v22.23.4，全套81/81通过，0失败/跳过/取消 |
| [tests-node24.tap](tests-node24.tap) | Node v24.22.2，全套81/81通过，0失败/跳过/取消 |
| [tests-node25.tap](tests-node25.tap) | Node v25.6.1，全套81/81通过，0失败/跳过/取消 |
| [tests-admin-budget.tap](tests-admin-budget.tap) | 管理员批次SQL预算调整后的托管同步定向回归11/11通过，0失败/跳过/取消；不是该调整后三个Node版本的全套重跑 |
| [evaluation.json](evaluation.json) | `synthetic_contract_evaluation`，16/16候选集合检查通过；3条原创合成CVE、6条来源记录 |
| [tree-evaluation.json](tree-evaluation.json) | `synthetic_tree_http_measurement`，4/4查询结果检查通过；2000条原创合成CVE，包含原始耗时、响应字节、执行计划及相关源码hash |

全套由 `node --test --test-reporter=tap cve/test/*.test.js` 运行，涵盖本地私有配置与路径保护、官方源托管缓存/对象读取、真实隔离PG批次事务、固定目标断点恢复、manifest失败不前移、删除/日期回退拒绝，以及只读HTTP/MCP状态与既有检索契约。PG检查使用显式管理员连接创建独立随机测试库，不把测试连接指定库当作可清空目标。

管理员批次的15秒预算在真实大库中出现超时，随后只给托管写批次和完整校验设置事务内120秒预算，读取事务仍为15秒。定向11项报告属于该修复后的检查；三份81项报告属于此前的完整回归。未将失败运行或尚未重跑的范围报告为通过。

合成树报告环境：Windows x64、Intel Core Ultra 7 155H、Node v25.6.1、PostgreSQL 16.15；100个web/1900个other候选，专用SELECT-only角色，单持有连接、并发1，每组1次热身与20次测量。它不等于421,286条真实全库、冷缓存、连接池、并发或生产SLA测试。报告内源码hash标识当时量测版本，不能自动代表随后所有改动。

## 本轮真实固定快照完成结果

[归档全量结果](full-result.json) 来自本机被忽略的 `artifacts/cve-full-work/full-complete-result.json`，实际返回 `status=complete`、`mode=full`、`resumed=true`；首次全量baseline的snapshot如下：

| 项目 | 完成结果 |
| --- | --- |
| 上游范围 | CVE Program官方cvelistV5固定提交中的公开CVE JSON，包含REJECTED |
| commit | `4acc5defac150feb879b4f6200a66121deb4c76d` |
| total | **421,286** |
| 状态分布 | **402,145 PUBLISHED + 19,141 REJECTED** |
| inventory_hash | `92bfb747e03317353390bda5637e5cfb8604470155c4b53292566740d723679f` |
| verified | **true** |
| completed_at | `2026-11-09T06:18:57.391Z`，即Asia/Shanghai 2026-11-09 14:18:57.391 |
| 累计counts | files/inserted均421,286；updated/unchanged/stale/skipped均0 |

最终run_id=4的本次运行counts只有25,786项，属于最后恢复段；总覆盖以snapshot.total与snapshot.counts为准。此前真实中断后从220,000条已提交批次继续固定commit，后续超时失败也保留已提交进度；完成标记是在完整清单数量/路径/blob身份、台账与当前observation hash、normalized一致性通过后发布，而非由下载成功或单条CVE可查询推断。

## 2026-11-10真实立即同步

[sync-now-result.json](sync-now-result.json) 来自本机 `artifacts/cve-full-work/sync-now-result.json`，仅将解析后的JSON按两空格格式化并统一为LF；字段和值保持不变。它返回run_id=5、`status=complete`、`mode=incremental`、`resumed=false`、`snapshot.verified=true`：

| 项目 | 最新已完成结果 |
| --- | --- |
| commit | `1a94c9aa74fbdc2a41e532a2e4dc145c81e89239` |
| 完整快照total | **421,868** |
| 状态分布 | **402,712 PUBLISHED + 19,156 REJECTED** |
| inventory_hash | `48daa9e3932885c548e6d5ce4534476ca39b261a25895f08c656af56a7792d28` |
| verified | **true** |
| completed_at | `2026-11-10T03:26:00.200Z`，即Asia/Shanghai 2026-11-10 11:26:00.200 |
| 本次增量counts | inserted=582、updated=807、files=1,389；unchanged/stale/skipped均0 |

完整快照比首次baseline净增582项，1,389只表示本次增改文件数。增量应用后再次校验完整manifest与当前证据一致性才更新completed；不是只核验新增文件。该结果固定到所列commit和完成时间，不宣称其后的上游提交已实时到达本地。

## 重启后的真实持久读取

[live-verification.json](live-verification.json) 归档自本机 `artifacts/cve-full-work/live-verification.json`，解析后两空格格式化并统一LF，字段和值保持不变。生成时间 `2026-11-10T03:28:44.317Z`；独立CVE容器实际stop/start后，最新snapshot仍为421,868项、`verified=true`，commit与上面增量结果一致。

- 年份分组覆盖1999～2026共28年，数量合计421,868；数据库大小 **4,348,476,439 bytes**。
- 8项HTTP检查全部200：ready、sync-status、树根、web/ngix产品别名及CVE-1999-0001、CVE-2014-0160、CVE-2021-44228、CVE-2026-0001的精确上下文。
- 第9项为固定observation `334911`（CVE-2026-0001）的完整读取与内容hash核对；归档只保存身份/hash，不保存第三方原文。

这是单次串行功能检查，不是负载测试或检索质量评测。报告中的单次耗时不代表p50/p95、并发吞吐或生产SLA；例如树根一次约9.51秒，后续性能工作仍应在明确冷热状态、规模和并发条件下测量。

## 尚未由本目录证明的事项

2026-11-10已恢复原Docker profile，CVE PG与原shujuku容器healthy，HTTP3100已运行；独立CVE容器stop/start后的跨年份、HTTP与完整observation持久读取已由上面的真实报告核对。此固定公开快照不包括未公开RESERVED详情；NVD/GHSA/KEV/CIRCL均有独立覆盖，本次没有证明这些补充来源全量。未完成生产部署、备份恢复演练、长期自动同步、真实问题集Recall/Precision评测、真实智能体联调或目标漏洞受影响判定。实际提交、推送及CI结果见Git日志和最终交付，不沿用历史成功记录。

较早 [tree-2026-11-09](../tree-2026-11-09/README.md) 的38项回归及 [2026-11-08历史记录](../../STATUS.md#2026-11-08-历史基线) 保留为历史，不能替代本目录的新工程回归与本轮真实快照结果。当前源码、归档报告与实际运行结果应按各自时间和范围理解。
