# 开发者首次接入：从空库到可读取上下文

> 历史项目记忆原型上手指南。2026-11-09 起 Memz 的主产品是智能体漏洞知识库，新接入请使用 [CVE 启动说明](../cve/README.md#启动与权限) 和 [智能体调用指南](cve-agent-guide.md)。下文的账号、审批与旧服务不属于新产品的接入流程。

以下命令在仓库根目录执行，使用POSIX shell（Linux/macOS/Git Bash语法）；本轮实际验证的是Linux。只需Node/npm、Docker Compose和公开演示账号，不需要模型、API key或外部账号。Windows PowerShell需改写环境变量语法，本轮未验证。

## 1. 安装与启动

终端A：

```sh
npm ci
docker compose up -d --wait
npm start
```

保持终端A运行。默认数据库端口5432、应用端口3000；以启动日志中的实际应用地址为准。首次空卷会自动创建应用角色、表、RLS和种子。已有数据卷不会重新初始化，不应为重复演示而重置。

这里的 `npm start` 是交互开发入口；前台终端的 Ctrl+C 通常向整个前台进程组发送SIGINT。需要 supervisor 或精确PID信号停止时，在仓库根目录直接执行 `node server.js`，让监督器以exec形式启动它；若必须经shell启动，最后使用 `exec node server.js`。不要只向npm PID发信号并假定应用已停止，详见[启动与有界排空](runtime-reliability.md#命令行服务启动与退出)。

## 2. 先验证接入地址与数据库

终端B（仍在仓库根目录）：

```sh
export MEMZ_BASE_URL=http://127.0.0.1:3000
MEMZ_QUERY=项目 node scripts/context-client.js
```

全新种子应返回一条“项目／截止日＝20号”、version=1及原始来源。已有库以实际数据为准。看到登录页或登录成功不能单独证明数据库配置正确；这条命令还验证项目权限、当前事实和溯源读取。默认使用公开viewer账号，并在完成后注销。

## 3. 写入、审批与实际客户端读取

```sh
mkdir -p artifacts/onboarding
MEMZ_DEMO_BASE_URL="$MEMZ_BASE_URL" node scripts/demo-story.js > artifacts/onboarding/story.json
```

脚本生成唯一的合成主体，真实创建来源与候选，再由owner批准和更正，检查409、驳回、历史依据及403。结果包含7个阶段和最终15号v2的完整上下文。它新增合成数据，不删除已有记录；中途失败也不是整段原子回滚。

需要可读演示记录时运行：

```sh
MEMZ_DEMO_BASE_URL="$MEMZ_BASE_URL" node scripts/demo-story.js --markdown > artifacts/onboarding/story.md
```

**再次执行会创建另一条独立演示故事**，不是把上一份JSON转换成Markdown。两份记录的主体和ID可能不同，都以各自实际响应为准。更详细的界面演示见[演示步骤](demo-script.md)。

## 4. 让另一个本地进程读取有界上下文

```sh
printf '%s' '{"projectId":1,"limit":1,"maxOutputBytes":4096}' | node scripts/context-client.js --stdin
```

成功stdout是一个完整JSON，失败stdout为空、stderr为错误码、退出码非零。若truncated=true，把实际nextAfter作为下一次请求的after；保持项目与关键词一致。例如实际游标为42时：

```sh
printf '%s' '{"projectId":1,"limit":1,"maxOutputBytes":4096,"after":42}' | node scripts/context-client.js --stdin
```

42只是示意值。不要在游标为null时继续请求。预算包括UTF-8 JSON转义、缩进和换行；来源不被截断，放不下第一条完整事实时明确失败。跨页不是共同快照，详情见[客户端合同](context-client.md)。

## 5. 端口与两种地址不要混淆

DATABASE_URL是**应用连接数据库**的地址，使用memz_app角色；MEMZ_BASE_URL是**客户端连接HTTP服务**的地址。完整故事脚本使用MEMZ_DEMO_BASE_URL，应与后者一致。PORT只修改应用端口，不会自动改变另外两个变量；终端之间也不会自动共享后来设置的环境变量。

例如保留现有5432/3000服务，可在支持 `!override` 的Compose版本中建立仅供本次独立演示使用的覆盖文件（本轮使用Compose2.40.3）：

```yaml
# compose.local.yml
services:
  db:
    ports: !override
      - "127.0.0.1:5433:5432"
```

```sh
docker compose -p memz-local-check -f compose.yml -f compose.local.yml up -d --wait
DATABASE_URL=postgres://memz_app:memz_demo_only@127.0.0.1:5433/memz PORT=3001 npm start
```

终端B对应设置 `export MEMZ_BASE_URL=http://127.0.0.1:3001`，再执行上述客户端和故事命令。项目名用于隔离容器和卷；先确认示例端口没有被占用。不对已有数据库执行down -v。

## 本轮实际遇到的环境问题

- **npm缓存目录不可写**：受限云环境中默认缓存位于不可写目录，npm ci报ENOENT。改用可写的临时缓存后安装成功：`npm ci --cache "$(mktemp -d)"`。不需要关闭包完整性检查，也不需要修改全局目录权限。
- **初始化SQL不可读**：受限umask使新拷贝的db/schema.sql为600，容器内PostgreSQL无法读取，日志明确显示Permission denied。确认是仓库中的公开合成schema文件后，仅对该文件执行 `chmod a+r db/schema.sql`；不修改数据库数据目录权限。检查 `docker compose logs db`，不能把容器重启当作初始化已成功。失败初始化可能留下部分卷，已有卷不会自动重跑schema；只有确认属于本次新建、无保留数据的隔离演练卷才可重建，已有库须保留并按实际情况修复。
- **地址配置错位**：应用改端口后，客户端默认仍是3000；明确设置MEMZ_BASE_URL和MEMZ_DEMO_BASE_URL，避免误连另一实例。

基本接入不要求系统安装pg_dump或浏览器。完整系统验证另需PostgreSQL工具，UI证据另需Chromium与中文字体，见README验证章节；不要为初次读取上下文就混入全部取证依赖。

首次安装或恢复旧库后，先运行 `node scripts/check-setup.js`。它使用应用连接做只读基本检查，能识别缺迁移和误用管理员连接；未通过时按 [诊断说明](setup-check.md)保留数据处理，不自动修复，也不代替完整业务流程验证。

## CI 的 Node 版本与证据

现有集成测试job分别在Node22和24执行，每个matrix job仍限15分钟；fail-fast=false使其中一个失败时另一个继续，离线Python准备检查仍只运行一次。两个Node版本执行相同测试与取证步骤，不能用其中一个通过代替另一个的结果。Node22保留全部原artifact名称；Node24统一追加 `-node24`，例如 `system-test-evidence-node24`、`ui-evidence-node24` 和 `competition-evidence-node24`。取证时按同一提交和对应job核对报告，不混用两个运行时的文件；配置存在不代表该次GitHub运行已通过。
