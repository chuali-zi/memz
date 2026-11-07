# 安装与恢复后的只读诊断

首次安装、恢复备份或升级旧卷后，先在仓库根目录执行：

```sh
node scripts/check-setup.js
```

默认使用与应用相同的本机公开演示连接，可由 `DATABASE_URL` 覆盖。只接受 pg 实际解析后的本机 TCP 地址（127.0.0.1、localhost、::1）；连接串中的 host 查询覆盖也经过检查。不会打印连接串、账号密码或原始数据库错误，不要求输入管理员凭据。

成功返回 JSON `ok: true`、`code: BASIC_CHECKS_PASSED`，退出码 0；未通过返回明确诊断和退出码 1。需要检查通过才启动时，可运行：

```sh
node scripts/check-setup.js && npm start
```

检查使用应用角色和只读事务，最后回滚并关闭连接。它只读取角色及系统目录，不读取业务原文、创建会话、生成候选、执行迁移或修改权限；没有自动重试或自动修复。连接和查询分别设 5 秒超时。已有 `npm start` 行为保持兼容，不会隐式执行诊断。

诊断会从连接 URL 删除所有 `connectionTimeoutMillis`、`query_timeout` 和 `statement_timeout` 同名参数，再应用自己的5秒期限，包括重复参数。其他参数保留，因此实际 host/port 的查询覆盖仍参与本机目标校验，`application_name` 等正常设置也不丢失。不改变应用连接池的生产期限。5秒是分别作用于连接或单次查询的期限，不是整个诊断过程的总时限；失败后的回滚也属于单独一次查询。

曾用只在回环地址监听的原创协议对端复现：对端完成 PostgreSQL 启动后不响应 `BEGIN READ ONLY`，旧命令的 URL 参数 `query_timeout=60000&statement_timeout=0` 使其在6.2秒探针截止时仍未返回。现在同类对端会由固定查询 deadline 结束并输出固定 `DATABASE_UNAVAILABLE`。`test/setup-check-deadlines.test.js` 同时验证启动不响应和查询不响应两条路径、重复覆盖、实际目标校验保留及日志不回显合成口令；它不连接真实数据库、不伪称 PostgreSQL/RLS 验收。真实数据库诊断兼容仍由既有隔离 setup-check 测试验证。

## 覆盖范围

- 能否连接并查询数据库；连接/认证错误只输出固定提示。
- 会话身份与当前角色是否为超级用户、BYPASSRLS、CREATEROLE，或能继承所需表 owner 权限；管理员连接后SET ROLE降权不能绕过此项。
- public schema 的八张基本表是否存在，其中包括迁移 002 的幂等回执表。
- 表是否启用 RLS、应用角色是否具有读取权限，身份函数是否存在且可执行。
- facts 的两个当前修订约束名称是否存在且已验证，用于提示遗漏迁移 001。
- 所需列及基本类型是否匹配；每表是否存在适用于当前角色或PUBLIC的permissive读取策略。它与[本机readiness](health-probes.md)共享一条目录查询，但不读取业务行。
- 迁移003的memberships.active须为普通boolean列、NOT NULL且默认true（非generated/identity）；member_role(int)须与受支持的精确SQL函数定义、SQL/STABLE/SECURITY DEFINER属性、int→text签名、固定search_path及迁移标记一致。标记本身不能证明函数体安全；即使只是改写等价函数源码，也不会视为已支持合同，可由维护者核对后重新执行003。
- SECURITY DEFINER成员函数的实际owner须有可行的非递归读取路径：owner自身为superuser；否则须同时具备public USAGE与memberships SELECT，并满足以下二者之一：自身BYPASSRLS，或memberships未FORCE RLS且可继承该表owner权限。不能仅凭函数体正确就认定可用；不满足返回SCHEMA_PREREQUISITES，需维护者核对函数owner及实际权限。重跑003不会更换已有函数owner或追加ACL，不能作为此项的自动修复。
- public schema的USAGE、会话row_security开启，以及业务表/身份函数按实际名称解析到已检查的public对象。目录关系、内建函数、运算符和相关类型使用pg_catalog限定，不通过自定义同名对象检查。

这是一组基本前提检查，除上述active及成员函数合同外，不逐条比对所有列属性、策略表达式、约束定义或写入权限，不证明业务数据正确、备份可恢复、生产安全或整个演示可用。通过后仍需实际登录并走来源—待审—审批—读取流程，或运行推荐的隔离系统测试。不要把 BASIC_CHECKS_PASSED 当成完整验收。

## 失败时的保留数据路径

| 代码 | 建议处理 |
| --- | --- |
| DATABASE_UNAVAILABLE | 确认本机 PostgreSQL 已启动、认证和端口配置正确；不要把原始连接串贴进公开日志 |
| UNSAFE_DATABASE_ROLE | 应用和诊断使用 memz_app；管理员连接仅用于维护，不传给应用 |
| SCHEMA_MISSING | 先核对连接的数据库；只有明确的新空库才初始化，不能为消除报错而删除旧卷 |
| SCHEMA_PREREQUISITES | 列、类型、active属性、适用读取策略或运行时schema/RLS前提不符；请维护者核对schema、授权与连接设置，不自动修复 |
| MIGRATION_REQUIRED | 暂停写入、备份并核验备份，按 README 顺序执行 001、002、003，再运行诊断 |
| RLS_DISABLED / SCHEMA_PERMISSIONS | 请维护者核对 schema、权限及迁移；诊断不会自动改授权 |
| LOCAL_DATABASE_REQUIRED | 核对实际解析目标；本工具不做外部数据库运维 |

## 隔离复现证据

`test/setup-check.test.js` 在随机 `memz_setup_*` 库加载原始 schema，启动真实应用子进程。实际观察到启动日志、登录与项目读取成功，但带幂等键的来源创建因缺少回执表返回 500。诊断返回 MIGRATION_REQUIRED；失败写入与诊断都未改变已有行。随后仅在该临时库应用 001/002，诊断通过且原有数据保持一致。

另在新 schema 临时库验证应用连接通过、管理员连接被拒绝、关闭 RLS 被识别、错误密码不出现在报告中，以及连接串查询参数不能将诊断转向外部地址。测试仅改变/删除自己创建的临时数据库，不触及现有演示库；由 `npm run test:system:evidence` 自动运行和记录原始 TAP。

上述原始schema→001/002是003之前的历史检查点，不能作为当前成员停用合同通过的证据。当前诊断保留既有检查优先级，并先核对上述函数owner前提，再判断003：缺少active列或成员函数不符合受支持定义返回MIGRATION_REQUIRED；active列存在但类型、非空、默认值或普通列属性不符返回SCHEMA_PREREQUISITES。它只查系统目录，不调用成员函数或扫描成员业务行，不证明具体撤权名单正确。恢复旧备份后还须按[恢复说明](backup-recovery.md#撤权状态与回退)核对备份后的访问变更。
