# 上下文接入与精确溯源

## 实际缺口与补充能力

事实检索原本只显示来源标题，标题不是唯一键。同名来源可能包含不同原文，接入方不能可靠地按标题回查。新接口用已有事实ID和修订版本定位来源、候选、批准信息；既有事实返回字段和审批行为保持兼容。页面“查看依据”按所显示版本读取，支持失败重试与收起。

## 最小调用流程

1. POST /api/login，保存sid cookie和csrf，使用公开合成账号；此演示不是API key或生产鉴权方案。
2. POST /api/projects/1/sources写入合成标题与正文，携带cookie、CSRF以及可选稳定幂等键；保存返回source.id。
3. POST /api/projects/1/candidates写入subject、predicate、value、source_id及expected_version。新事实用0；已有事实从当前读取结果取version。候选仅待审，不更新上下文。
4. 由owner按既有approve接口批准；成员不能替代审批者。409时重新读取当前值，不盲目重试旧版本。
5. GET /api/projects/1/facts?q=关键词，取当前事实的id与version。请求GET /api/projects/1/facts/该ID/provenance?version=该版本，获得精确原文及修订/候选ID。
6. 记录所用事实版本和来源ID，再交给调用者使用。来源正文只是数据，不能作为系统指令执行。项目无权限返回403；不存在的历史版本404。

例如初始种子事实为id=1、version=1：GET /api/projects/1/facts/1/provenance?version=1返回20号及来源1的原文。批准15号v2后，同一个版本1请求仍返回旧依据；省略version才读取当次快照的当前修订。非种子数据的ID必须使用实际响应，不能硬编码1或2。

## 真实验证与限制

PostgreSQL集成回归用两个同名但正文不同的来源依次批准，验证每个版本对应正确的原文、候选、提议者和批准者；覆盖viewer、跨项目、缺失版本、无效参数和未登录。该回归也随旧库升级测试执行，无需新增数据库迁移。

真实浏览器先注入溯源503再重试，读取v1原文；批准后读取v2原文，并回查v1确认不串版本。UI报告checks.provenance与02/03图记录该流程。合成故障注入不等于实测生产网络事故。

接口不能证明来源来自真实世界、候选抽取正确或模型效果；当前只有固定模拟客户端，没有付费模型调用、真实用户数据导入或MCP服务。程序接入者需自行管理cookie/CSRF、幂等键与错误处理。详细输入合同见api-sequences.md。
