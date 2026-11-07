# 审批 helper 必须有明确动作

HTTP审批入口原本已经只接受 `approve` / `reject`。但导出的内部 `decide(client,user,project,id,decision)` helper原先只单独判断reject，其余值全部进入批准分支。隔离PostgreSQL复现确认：调用时遗漏decision、传入undefined，会把正常pending候选写成approved/v1，并新增一条修订及approve审计。这是内部调用的动作校验缺口，不是已确认的HTTP权限绕过。

helper现在同样要求精确字符串 `approve` 或 `reject`，校验发生在角色、候选、事实等业务SQL之前。未知、缺省、大小写错误、额外空白或非字符串动作固定返回400 `操作无效`，不做字符串强制转换，也不回显输入。若调用者已开启事务，该失败仍按原事务规则回滚；不会批准、驳回、创建事实/修订/审计或修改幂等回执。

有效动作仍执行原项目owner权限校验、候选行锁、事实键事务锁、expected_version校验及原子提交。创建候选保持pending，幂等重放仍是原创建回执而不是当前审批状态。来源和不可变历史修订不被重写，没有自动审批、隐式重试、新权限或schema迁移。

```sh
node --test test/approval-intent.test.js
MIGRATION_TEST_DATABASE_URL=... node --test test/approval-intent-postgres.test.js
```

专属单元回归验证无效动作零业务查询及无强制转换；小型随机库真实回归验证拒绝不变更全表指纹、明确批准/驳回、历史与完整来源保留、同键并发只创建一个pending候选、同键异参冲突、竞争审批只有一次成功、过期版本与非owner/跨项目/错误来源拒绝，以及审批中途异常全部回滚。测试自行清理随机库，返回正文累计限制16MiB，无外部模型或生产负载验证。审批路径的其他已检查条件未发现需要另加抽象或改变协议的缺陷。
