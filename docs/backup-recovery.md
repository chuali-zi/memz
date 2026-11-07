# 备份恢复演练

已有升级说明要求先备份，但命令成功本身不能证明可恢复。本项使用真实PostgreSQL工具和应用子进程验证一条完整恢复路径，不覆盖现有数据库，不把合成测试称为生产灾难恢复。

## 自动复现与证据

按README的 `test:system:evidence` 运行。核心套件自动包含 `test/restore.test.js`，需要PostgreSQL 16客户端工具；在常见Linux安装位置优先选择16版本，再回退PATH。云端开发环境使用数据库容器内16版本工具，可设置 `PG_TOOLS_CONTAINER=memz-resume-check-db-1`；其他环境应填写实际容器名且核对连接地址在容器内可达。密码只经子进程环境传递，不加入命令参数或TAP。

流程只创建两个随机 `memz_restore_*` 数据库，管理员连接指定的原库不作为恢复目标。测试完成关闭子进程与连接并删除自己创建的随机库。

## PostgreSQL 工具版本与 CI

恢复测试分别为 `pg_dump` 和 `pg_restore` 选择工具，顺序如下：

1. 设置 `PG_TOOLS_CONTAINER` 时，两者都通过 `docker exec -i` 在该容器内执行；此设置优先于宿主机工具。
2. 未设置时，优先使用 `/usr/lib/postgresql/16/bin/` 下对应工具。
3. 若该文件不存在，使用 PATH 中同名工具。此回退不会验证主版本，不能因命令存在便假定它是 16。

GitHub Actions 的数据库服务使用 `postgres:16`，系统测试步骤以 `PG_TOOLS_CONTAINER: ${{ job.services.postgres.id }}` 选择该服务容器内的两项工具，避免 `ubuntu-latest` 的预装客户端版本变化影响恢复。容器内 `pg_dump --version`、`pg_restore --version` 和服务端 `SHOW server_version` 应均为 16 系列；镜像标签没有固定补丁版本，因此不能据此声称每次都是同一补丁版本。

不要只核对 `pg_dump`。PostgreSQL 17 的归档恢复实现会在设置恢复会话状态时发出 `SET transaction_timeout = 0`，旧服务端可能因此报 `unrecognized configuration parameter "transaction_timeout"`；错误本身不足以判定是哪个客户端被选中。参见 [PostgreSQL 17 官方归档恢复源码](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/bin/pg_dump/pg_backup_archiver.c) 的 `_doSetFixedOutputState`。项目的 PostgreSQL 16 恢复演练应同时选择 16 系列的备份与恢复工具；[pg_dump 官方兼容性说明](https://www.postgresql.org/docs/16/app-pgdump.html#APP-PGDUMP-NOTES)也明确不保证新版工具生成的备份可以加载到旧主版本服务器，即使源服务器就是旧版本。

容器工具仍原样使用测试连接 URL 的 host 和 port，脚本不会把宿主端口转换为容器端口。CI 当前使用 `127.0.0.1:5432`，它在 runner 和 PostgreSQL 服务容器内均指向该测试服务；本机若映射为 `127.0.0.1:55432 → 容器:5432`，直接为该 URL 添加 `PG_TOOLS_CONTAINER` 会失败。此时应使用已安装的本机 16 系列工具，或由维护者配置 runner 与工具容器均可达的地址；不能将改写 URL 后未经验证的路径视为通过。

版本查询只证明工具选择前提，不能替代真实恢复演练。修复 CI 工具选择后，需重新运行完整系统测试，确认恢复测试通过并清理随机库；不应忽略恢复错误、过滤归档 SQL、移除 `--exit-on-error` 或沿用旧成功报告来取得通过状态。

## 恢复测试工具的超时与子进程收尾

`test/pg-tool-helper.js` 只服务于合成恢复演练，不改变人工备份命令或生产服务。默认工具运行期限仍为60秒、stdout上限仍为8 MiB，PostgreSQL 16及容器工具选择顺序保持不变。密码仍只通过子进程环境传递；stderr只排空，不记录或回显。正常退出保留原 `{code,bytes}` 回执，包括损坏归档的非零退出。

旧 helper 在超时或输出超限时仅发送 SIGTERM 就立即拒绝 Promise；真实拒绝 SIGTERM 的合成子进程仍能继续存活。现在第一次致命原因固定后，先发 SIGTERM，250ms宽限后仍未关闭则对这个直接子进程发送 SIGKILL，并等待其 `close`（退出与stdio收尾）才拒绝。输出超限不继续缓存数据；spawn/流/同步stdin错误只保留固定错误代码，清除计时器，后续错误不会覆盖首个原因。工具非零退出时的 stdin EPIPE 保留非零回执；若工具报告0但有输入未交付，则失败而非成功恢复。

独立无数据库回归：`node --test test/pg-tool-lifecycle.test.js`。它使用真实、已确认安装拒绝 SIGTERM handler 的 Node 合成子进程，以测试参数缩短期限，验证 TERM→KILL→close、进程已不可达、stdout超限、EPIPE、spawn失败及合成凭据不回显。不通过环境变量放宽实际恢复测试的60秒默认期限。这些进程故障回归不替代真实 PostgreSQL 的 custom dump/restore 验证。

收尾结论只限本机直接启动的 CLI 子进程及其stdio。杀死 `docker exec` 客户端不保证容器内 PostgreSQL 工具已停止；脚本也不遍历或杀死整个进程树，不停止共享容器或改动网络。需要可靠取消容器内/多级进程或处理内核无法立即终止的任务时，应使用明确管理目标任务的外部 supervisor；未观察到 close 不能宣称清理完成。本演练不把 CLI 结束等同于所有远程操作已经回滚或备份可恢复。

## 实际演练步骤

1. 源测试库初始化，用真实HTTP创建带幂等键的来源和候选，批准截止日从20号v1到15号v2；保存客户端上下文。成员另建带幂等键的合成来源，再由测试管理员仅将项目1/用户2的 active 设为false，保留成员行与角色。
2. 停止该测试应用写入，记录八张业务表、序列位置、外键/检查等约束、RLS策略和权限。用 `pg_dump --format=custom` 生成真实归档。
3. 将归档截断为16字节，尝试恢复到空目标库；要求非零退出且目标仍无业务表。这是损坏头部负向测试，不声称覆盖所有归档损坏或恢复中断情形。
4. 对完整归档执行 `pg_restore --exit-on-error --single-transaction --no-owner`；逐项比较恢复结果与源快照。
5. 新应用进程读取恢复库，确认上下文完全一致，readiness返回200。同一个负责人来源幂等键返回原ID；已停用成员仍能用公开账号登录，但项目事实和原键重放均被拒绝，数据与序列不变；另项目账号被拒绝，应用数据库角色无身份和跨项目SQL读取均返回零行。
6. 恢复后创建新来源与候选，确认ID继续增长，再批准16号v3；回查v2仍是15号及原来源。最后确认源库没有变化并清理。

系统报告的core套件及原始core.tap保存实际通过/失败状态、归档字节数、SHA-256和清理诊断；同提交材料包包含源码、说明和TAP。归档本身只在测试进程内存中使用，不作为用户数据备份上传。字节数和哈希描述该次合成归档，不是性能指标。

## 人工恢复操作的边界

README的升级备份使用 `sh scripts/backup-before-migration.sh`，必须从该脚本所属仓库的根目录运行，并先核对正在维护的Compose项目。预检要求001、002、003迁移文件均存在，否则在调用Docker和创建本次备份目录前失败。它沿用 `docker compose exec -T db pg_dump -U postgres -d memz -Fc` 的目标和工具；不选择其他连接、不执行迁移或恢复。成功只向stdout输出一个绝对 `.dump` 路径，文件在本次 `mktemp -d` 创建的独有目录中，目录/文件使用私有权限。旧备份不被覆盖；dump失败或为空时非零退出，stdout为空，只尝试删除本次文件并移除本次空目录，不递归删除或碰其他文件。脚本失败不会证明源库需要重置。

在同一shell用 `memz_backup=$(sh scripts/backup-before-migration.sh)` 保存路径；失败会把该变量置空，即使此前变量指向旧文件。README迁移命令另用显式 `test ... && ... && psql ... && psql ... && psql ...` 按001→002→003短路执行，001失败不启动002，002失败不启动003，003失败也非零结束。文件存在和非空只是执行前提，**不证明归档完整或可恢复**。停止写入后，必须用这一次实际备份在独立空库做真实恢复并验证版本、原文、权限和继续写入，再决定切换或迁移；`pg_restore --list` 不替代此步骤。现有 `test/restore.test.js` 验证的是它自行生成的随机测试归档，不能替代对本次人工备份的验证。

对实际备份，应先停止写入并确认备份对象、PostgreSQL版本、原角色及权限配置；在独立空数据库验证后再决定切换。不要把验证命令直接指向当前演示库，不使用 `--clean` 覆盖已有数据。本测试的 `--no-owner` 将对象归恢复执行者所有，因此源/目标在同一测试管理员与预建memz_app角色下比较；跨集群须另行配置角色，数据库级pg_dump不备份角色密码等全局对象。恢复后还须核对SECURITY DEFINER成员函数owner的schema USAGE、memberships SELECT及非递归RLS读取条件；错误owner可能使正确函数体递归失败。readiness/只读诊断会将此类前提不符报告为SCHEMA_PREREQUISITES；重跑003不会更换既有函数owner或追加ACL，须由可信维护者核对实际owner与权限，不能通过给应用增加表更新权限绕过。

`node --test test/backup-before-migration.test.js` 仅在临时目录用合成Docker替身验证命令退出、唯一备份、旧文件保留和迁移短路，不启动Docker或数据库，也不把替身输出称为有效归档。材料包按已跟踪的 `scripts/` 目录收录源码，不限制扩展名，因而包含这个 `.sh`；调用使用 `sh`，不依赖解包后的可执行位。

此流程验证逻辑备份的指定恢复路径，不是持续归档、时间点恢复（PITR）、多机故障演练、自动备份保留策略或RPO/RTO承诺。它在停止写入的合成库上执行，不证明并发备份时业务时间点一致性。应用会话仅存内存，恢复数据库不会恢复登录会话，使用者需重新登录。不会自动注册赛事、对外提交或触及生产数据。

## 撤权状态与回退

逻辑备份保存的是备份时刻的 memberships.active、原角色及权限函数。恢复测试中的已停用成员必须仍为false，并保留来源/审计/回执引用的成员行；这仅证明合成归档中已有撤权不被该恢复路径丢失。它不能涵盖备份之后的新撤权。恢复旧备份可能重新授予这些用户访问；003之前的备份升级时默认active=true，更须在开放流量前，依据可信维护记录按项目/用户核对并补回撤权。重新登录本身不能完成这项核对。

仅回退应用二进制也必须保留003的active列和过滤后的member_role；存在撤权时不得删除列或恢复未过滤函数。成员停用由schema owner限定范围参数化UPDATE，不授予应用更新memberships的权限，不删除成员或历史。参见[维护操作](demo-boundary.md#项目成员停用)。
