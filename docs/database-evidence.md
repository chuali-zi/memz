# 数据库系统测试的原始证据

六项材料中，设计约束和升级能力需要能追溯到实际执行结果。此入口将已有核心与迁移测试运行在随机临时库，保存原始TAP及代码指纹，并纳入同提交材料包。所有业务数据为合成数据，测试不证明真实用户收益。

## 复现

先初始化专用测试PostgreSQL及现有共享memz_app角色（见README），使用具备fixture管理权限的测试管理员连接：除了创建数据库，core中的隔离进程测试还会创建/清理随机登录角色，并需要schema owner等测试操作权限；仅CREATEDB不够。推荐专用测试实例的postgres管理员，不使用生产凭据。按层选择命令见[测试入口](testing.md)。

```sh
SYSTEM_TEST_DATABASE_URL=postgres://postgres:postgres_demo_only@127.0.0.1:5432/memz npm run test:system:evidence
```

该地址为公开演示配置。程序不重置提供的数据库；创建随机memz_system库，初始化schema，以非owner应用角色执行核心测试。迁移测试另建随机库，验证保留数据升级、重复和并发迁移、失败回滚、幂等创建及分页。各fixture仅对自己创建的库/临时角色执行清理，不删除已有memz_app；需要管理员是为这些隔离测试管理操作，不代表应用以管理员运行。强制终止、连接错误或finally失败可能留下已登记资源，不能承诺任何失败都清理成功；按TAP及清理记录核对确切owned名称。无完整清理记录的报告不能打包。

输出artifacts/system/run-时间-随机值/：

- report.json：实际提交、工作区状态、源码SHA-256、Node/PostgreSQL版本、各套件退出状态、测试数量和临时库清理结果。
- core.tap、migrations.tap：原始Node测试输出，包括子测试名称和最终统计。
- core.stderr.txt、migrations.stderr.txt：标准错误，空文件也是保留的执行结果。

失败仍保存已有输出并返回非零状态。CI始终尝试上传system-test-evidence；它不等于成功证明。完整workflow终态须另行核实。已知管理员连接及密码会在保存前替换，但这些日志只适用于公开测试配置，不应把生产秘密放入测试数据。

## 从结果核查设计

| 材料主张 | 核查位置 |
|---|---|
| 审批、旧版本冲突、异常整体回滚、项目与角色隔离 | core.tap及test/integration.test.js |
| 旧库数据、序列、权限、策略保留，重复/并发执行安全 | migrations.tap及test/migrations.js |
| 当前指针不能串事实、串版本或丢失 | test/migrations.js的assertGuards，SQLSTATE23503/23514 |
| 同键创建重放、并发重复请求不重复写入 | 迁移套件调用的幂等回归与客户端竞态测试 |
| 页边界、并发状态变化和项目范围 | 迁移套件调用的分页回归；真实UI另看ui报告 |

数量由报告读取，不将顶层九组迁移误称为全部子断言数量。原始TAP是测试运行记录，源码中断言说明它实际证明的范围；通过不代表覆盖全部可能情况。

## 材料包校验

在干净提交运行系统、检索、UI取证，再执行npm run evidence:package。三份报告必须同提交。材料包保存evidence/system/全部五个文件；离线校验重新解析TAP，检查哈希、源码集合、退出码、摘要、无失败/跳过/取消/待办及清理确认。默认选最新系统报告，可用SYSTEM_REPORT_PATH显式指定；不会自动忽略最新失败记录。

校验值可发现不一致，不是数字签名或对测试真实性的第三方担保。仍须核对独立Git提交和CI来源。原始比赛通知、最终模板与提交渠道须人工复核。
