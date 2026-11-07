# 审批 helper 必须有明确动作

HTTP审批入口原本已经只接受 `approve` / `reject`。但导出的内部 `decide(client,user,project,id,decision)` helper原先只单独判断reject，其余值全部进入批准分支。隔离PostgreSQL复现确认：调用时遗漏decision、传入undefined，会把正常pending候选写成approved/v1，并新增一条修订及approve审计。这是内部调用的动作校验缺口，不是已确认的HTTP权限绕过。

helper现在同样要求精确字符串 `approve` 或 `reject`，校验发生在角色、候选、事实等业务SQL之前。未知、缺省、大小写错误、额外空白或非字符串动作固定返回400 `操作无效`，不做字符串强制转换，也不回显输入。若调用者已开启事务，该失败仍按原事务规则回滚；不会批准、驳回、创建事实/修订/审计或修改幂等回执。

有效动作仍执行原项目owner权限校验、候选行锁、事实键事务锁、expected_version校验及原子提交。创建候选保持pending，幂等重放仍是原创建回执而不是当前审批状态。来源和不可变历史修订不被重写，没有自动审批、隐式重试、新权限或schema迁移。

```sh
node --test test/approval-intent.test.js
MIGRATION_TEST_DATABASE_URL=... node --test test/approval-intent-postgres.test.js
```

专属单元回归验证无效动作零业务查询及无强制转换；小型随机库真实回归验证拒绝不变更全表指纹、明确批准/驳回、历史与完整来源保留、同键并发只创建一个pending候选、同键异参冲突、竞争审批只有一次成功、过期版本与非owner/跨项目/错误来源拒绝，以及审批中途异常全部回滚。测试自行清理随机库，返回正文累计限制16MiB，无外部模型或生产负载验证。审批路径的其他已检查条件未发现需要另加抽象或改变协议的缺陷。

## 浏览器审批回执接纳

审批按钮不能只因HTTP为2xx就声称操作成功。客户端接纳合同要求：批准回执的status必须为approved，version必须是1到2147483647的整数，并严格等于当前候选已知expected_version+1（expected_version本身也须为0到2147483647的整数）；驳回回执的status必须为rejected，不读取或展示额外version。两者只检查实际消费字段，允许未使用的附加元数据，不增加接口字段或审批权限。

格式异常、动作不匹配或版本不符应在成功反馈及自动读取刷新之前拒绝接纳，并固定提示“处理结果未确认、请刷新核对”。回执异常不证明服务器未提交，不能说候选一定仍待审、事实未更新或审计未产生；也不能自动重新审批、添加创建幂等键或转为批准。有效回执仍按原流程刷新，409版本冲突、owner控制和工作区迟到响应边界保持原样。

`node --test test/browser-decision-receipts.test.js` 用完整实际app.js、最小DOM及合成Response运行api、候选按钮处理函数、perform和工作台load；五个独立列表读取函数明确替换为保留旧行的stub。负向矩阵包含动作错配、空对象、错误版本和int32溢出，正向包含首版本、最大版本及附加字段；坏回执后不能宣称成功或触发自动重试。该测试不启动Chromium、HTTP服务、PostgreSQL或模型，不证明真实服务器提交与回滚；真实审批/409及工作区切换仍由既有UI/产品测试验证。每次套件最多40次业务mock调用，日志保存实际源码SHA-256；红基线与修复后通过结果须分别记录，不能把合成回执当作真实审批成绩。
