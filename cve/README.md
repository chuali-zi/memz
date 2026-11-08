# Memz CVE 知识库

这是 Memz 仓库中的独立、只读消费的公开漏洞知识模块。项目事实仍由原 Memz 的来源、候选、审批和修订机制管理；CVE 数据使用独立 `cve` schema、独立连接变量和端口。无需修改原 `server.js`、`package.json`、`db/schema.sql` 或现有数据库迁移。

## 为什么先用结构化检索 + 全文检索

CVE-ID 是精确标识；CWE 是弱点分类，一个 CWE 可以对应许多 CVE，不能把分类本身当作某个具体漏洞。厂商/产品、包生态、版本区间、CPE 的 AND/OR 条件、撤回状态、更新时间与来源都需要结构化保存。向量相似度不能证明某版本受影响，也不适合承担这些字段的唯一检索职责。

本版实现 PostgreSQL 参数化结构过滤、`simple` 全文索引和有来源的上下文摘要。英文关键词使用全部词项匹配，没有同义词扩展、中文分词、自然语言规划、语义排序或模型调用。`q=SQL injection` 是词项检索；`cwe=CWE-89` 是分类过滤。产品名称使用大小写不敏感的精确匹配，不猜别名。

后续若有真实问题集证明关键词漏召回，可为**描述/受影响产品证据**增加 embedding：以 `(observation_id, chunk, model, dimension, content_hash)` 绑定索引，合并结构化与向量候选，再评估排序。撤回处理、版本判断、来源回查继续依靠结构化数据。本轮未安装向量扩展、下载模型或宣称完成 embedding/RAG 效果评测。

## 数据来源与选择

| 来源 | 用途 | 已实现入口 | 更新/冲突处理 |
| --- | --- | --- | --- |
| [CVE Program cvelistV5](https://github.com/CVEProject/cvelistV5) | CVE 身份、发布/拒绝状态、CNA 与 ADP 证据；全量主源 | 本地 CVE JSON 5.x 目录；官方 Git clone 固定提交 | Git commit 断点，按变更文件导入；旧更新时间不覆盖新记录 |
| [NVD CVE API 2.0](https://nvd.nist.gov/developers/vulnerabilities) | CPE/configurations、CWE、各版本 CVSS、分析状态 | 本地 API JSON；线上 lastModified 窗口分页 | 初次显式起止窗口，最多 120 天；后续自动续窗，每页原子保存数据与断点 |
| [GitHub Advisory Database](https://github.com/github/advisory-database) | 开源包生态、GHSA/CVE alias、OSV 版本事件与修复引用 | 本地 OSV JSON；官方 Git clone 固定提交 | 按 source_id 保留独立记录；无 CVE alias 统计 skipped，移除 alias 会解除当前关联 |
| [CISA KEV](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) | 已知在野利用目录、日期和处置字段 | 可选完整 JSON feed 同步 | 按目录 dateReleased；完整快照移除项解除当前 membership，历史观察保留 |
| [CIRCL Vulnerability-Lookup](https://vulnerability.circl.lu/api/) | 可选单条镜像补查 | `sync --source circl --id ...` | 仅接受可识别的 CVE5/NVD 形状，来源标记为镜像；未知格式显式失败 |

官方 CVE 仓库包含 CNA/ADP 多个 container，导入器同时保留并合并引用的 tags。GHSA 原始数据使用 OSV，按上游 [CC-BY-4.0](https://github.com/github/advisory-database/blob/main/LICENSE.md) 保留署名链接。所有下载内容都应遵守相应来源条款；本仓库只提交原创合成 fixture，联网 smoke 不提交第三方原文。

全量推荐先导入 CVE Program 的官方 clone/解压目录，再补 NVD 与 GHSA，KEV/CIRCL 按需开启。每次 agent 查询读取本地库；查询路径不联网搜索，也不自动触发同步。未提供定时器，部署者可用系统计划任务周期性运行一次 `sync`。

## 启动与权限

需要项目已有 Node.js 22+、`pg`、Express 与 MCP SDK，以及 PostgreSQL 16。依赖已在根 `package.json` 中，不需要新增包。请按根 README 完成 `npm ci`。本机验证版本见 [STATUS.md](STATUS.md)。

建议管理员事先创建独立空库，例如 `memz_cve`。也可把本模块 schema 放在已有 PostgreSQL 数据库中；迁移只访问 `cve.*`，不读取或修改 `public` 中的项目数据。**仅设置 `CVE_DATABASE_URL`，不会继承 `DATABASE_URL`，也不内置连接密码。**

以下 PowerShell 中的 `<...>` 需替换为自己管理的连接，不要写进 Git：

```powershell
# 迁移连接必须是目标库的 schema owner；首次迁移/升级由管理员运行
$env:CVE_DATABASE_URL = '<schema-owner-connection>'
node scripts/cve_cli.js migrate

# 使用另行配置的导入连接
$env:CVE_DATABASE_URL = '<ingest-connection>'
node scripts/cve_cli.js import --source cvelist --path 'D:\datasets\cvelistV5\cves'
node scripts/cve_cli.js status

# 服务进程使用只读连接，默认仅监听 127.0.0.1:3100
$env:CVE_DATABASE_URL = '<readonly-connection>'
node scripts/cve_cli.js serve --port 3100
```

服务不提供账号系统，仅用于本机公开漏洞资料的只读访问。Host 限制为 loopback，跨 Origin 请求被拒绝，所有数据查询使用只读事务；导入与迁移只提供 CLI。不要将这个本地服务直接公开部署。

管理员可将以下权限授予**已配置好的专用角色**，示例角色名须按本机情况调整。迁移不会创建用户、修改身份或密码，也不给 `PUBLIC`、`memz_app` 新权限：

```sql
GRANT USAGE ON SCHEMA cve TO memz_cve_reader, memz_cve_ingester;
GRANT SELECT ON cve.records, cve.observations TO memz_cve_reader;
GRANT SELECT, INSERT ON cve.observations TO memz_cve_ingester;
GRANT SELECT, INSERT, UPDATE, DELETE ON cve.records TO memz_cve_ingester;
GRANT SELECT, INSERT, UPDATE ON cve.source_state, cve.checkpoints, cve.sync_runs TO memz_cve_ingester;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA cve TO memz_cve_ingester;
```

导入器只追加 observations，专用导入角色不需要其 UPDATE/DELETE 权限。`status` 需要读取 counts/checkpoints/runs，请在导入连接下执行。不要把管理员或导入连接传入 agent。迁移是事务性的、可重复执行，有锁/语句超时；没有自动 DROP、回滚到旧表结构或重置现有数据的命令。

## 导入、更新与恢复

上游资料建议保存在仓库以外。自行下载官方 clone 或 release 后，可以运行：

```powershell
# 官方 clone；工具只读取 origin 与固定 HEAD，不执行 clone/fetch/pull
node scripts/cve_cli.js sync --source cvelist --repo 'D:\datasets\cvelistV5'
node scripts/cve_cli.js sync --source ghsa --repo 'D:\datasets\advisory-database'

# 本地 JSON 文件或目录；支持 CVE5、NVD API envelope、GHSA OSV、KEV envelope
node scripts/cve_cli.js import --source nvd --path 'D:\datasets\nvd-page.json'
node scripts/cve_cli.js import --source ghsa --path 'D:\datasets\advisory-database\advisories'

# NVD 初次必须指定窗口；起止都要给，窗口跨度 <=120天
node scripts/cve_cli.js sync --source nvd --start '2026-11-01T00:00:00Z' --end '2026-11-08T00:00:00Z'
# 后续每次最多向前推进119天，并保留2分钟重叠；失败后按页断点恢复
node scripts/cve_cli.js sync --source nvd

# 可选来源
node scripts/cve_cli.js sync --source kev
node scripts/cve_cli.js sync --source circl --id CVE-2021-44228
```

可选 `NVD_API_KEY` 只作为 NVD 请求头使用，不转发给其他来源，不进入数据库、报告或日志。不设 key 时请求间隔至少 6.5 秒；设 key 时至少 650ms。429、5xx 和网络错误最多四次尝试，遵守有界 Retry-After/退避，单次 HTTP 有 30 秒超时，JSON 体上限 64MiB；401/403 等非瞬时错误直接失败。

本地目录导入每个 JSON 一个事务，文件夹中断后重新扫描即可；没有文件级游标，重复数据由 hash 去重。Git 首次遍历当前快照，后续根据保存的 commit diff；每个文件独立提交，只有整批成功才前移 commit。读取的是固定 commit 对象，工作区未提交内容不会导入。首次大库使用逐文件 `git show`，吞吐尚未优化/量测；只求快速初始加载时可用目录 importer，之后 Git 首轮仍会扫描一次以建立 commit 断点。上游历史缺失、非祖先历史或删除/重命名文件会停止，需人工核对来源后制定恢复方案；不自动删除已存漏洞。

NVD 数据页与页游标在同一事务中提交，失败页整体回滚，已提交页保留；失败/成功状态记录在 `sync_runs`。分页中的服务端数据会变化，重叠窗口是有限容错，不构成时间点快照或全历史完整性证明。若首次只同步最近一周，**本地库也只有该窗口，不能宣称完成 NVD 全量**；历史回填需按窗口顺序显式推进。不允许显式窗口跨过已完成断点制造空洞。

每个来源有数据库会话锁，阻止同来源两个同步任务重叠；不同来源可独立更新。进程被强杀后会话锁自动释放，`running` 记录可能保留供排查，重新执行以真实 checkpoint 为准。数据幂等不等于对整个上游历史做了完整归档。

## 表和一致性边界

| 对象 | 内容 |
| --- | --- |
| `cve.observations` | 原始 JSON、规范化 JSON、source/source_id/CVE-ID、source URL、上游 modified、抓取时间、规范化键序后的 JSON SHA-256；导入器追加写入 |
| `cve.records` | 每个来源/来源标识/CVE 当前 observation 指针、全文索引、last_seen；同 CVE 不同来源独立存在 |
| `cve.source_state` | GHSA 的更新水位，即使移除最后一个 CVE alias，也阻止旧快照恢复关联 |
| `cve.checkpoints` | Git commit、NVD 完成窗口/未完成页、KEV 目录版本 |
| `cve.sync_runs` | 开始/结束时间、running/complete/failed、实际已提交计数和脱敏错误码 |

hash 标识解析后 JSON 的规范化对象内容，**不是原始 HTTP 字节 hash**；JSON 字段顺序和空白变化不产生新 observation。相同 raw 更新 last_seen，不复制观察；同来源较旧的 modified 被拒收；相同 modified 但内容变化会保存新观察。上游没有日期的来源不能覆盖已有带日期记录。

状态的展示优先级是 `cvelist > nvd > ghsa > circl > kev`，不把后抓到的镜像当作更权威。默认只返回 PUBLISHED，官方 REJECTED 会压住仍未更新的 NVD/KEV；`include_rejected=true` 和精确详情可以检查撤回原因。GHSA 的 withdrawn 只描述该 GHSA，不能替另一个来源撤回 CVE。所有来源的描述/评分仍独立返回，不强行融合成单一“正确”分数；展示优先级是本模块策略。

NVD configurations 的 AND/OR、环境条件、`vulnerable:false`、含排除边界的版本范围原样保存。环境 CPE 不作为受影响产品投影。CPE 转义分隔符有专门处理，不能简单按冒号切割。GHSA 保留 OSV events、显式 versions、purl；CVE5 保留 versions/defaultStatus/packageURL 等原结构。

## HTTP/agent 契约

| 接口 | 行为 |
| --- | --- |
| `GET /health/ready` | 只读检查 CVE schema 是否可访问；不是覆盖率/新鲜度证明 |
| `GET /api/cve/:CVE-ID` | 精确查询，包含撤回记录；不存在返回404 |
| `GET /api/cve/search?...` | 结构化/词项搜索，来源摘要，CVE-ID 升序游标分页 |
| `GET /api/cve/context?...` | 相同候选，64KiB 输出预算，带 citation 的 agent 上下文 |
| `GET /api/cve/observations/:id` | 按固定 observation ID 返回完整 raw/normalized 与来源，16MiB 预算 |

搜索参数：`id`、`q`、`vendor`、`product`、`version`、`cwe`、`cpe`、`kev=true/false`、`include_rejected=true/false`、`limit=1..50`（默认10）、`after=CVE-...`。至少一个实际检索条件；重复、未知、错误类型参数返回400。CPE 使用完整 criteria 精确匹配。描述过滤需由同一来源记录同时满足；同一 CVE 的其他来源仅作为证据附上。`kev` 按当前目录 membership 再过滤。分页按字符串 CVE-ID 升序，无相关度排序或总数；每页打开新快照，并发更新期间不保证跨页固定集合。

`version` 必须与 `product` 一起提供，只标明待评估的目标版本。响应明确返回 `requires_ecosystem_specific_evaluation`，**不会据此过滤并断言受影响/不受影响**。完整版本范围在 observation 中；不同生态、预发布版、回补修复和组合配置尚无通用判定器。

```powershell
Invoke-RestMethod 'http://127.0.0.1:3100/api/cve/CVE-2021-44228'
Invoke-RestMethod 'http://127.0.0.1:3100/api/cve/context?product=log4j&cwe=CWE-502&limit=3'
Invoke-RestMethod 'http://127.0.0.1:3100/api/cve/context?q=SQL%20injection&limit=3'
```

只有本地已导入资料会命中；无命中时 `items=[]`、`citations=[]`，不编造 CVE 或触发 web search。上下文标记 `untrusted_data:true`，每个 source 摘要有 `excerpt:true` 和 `observation_path`。描述、产品和引用有显式长度/数量上限；摘要不复制版本区间或 CPE 逻辑树，防止只读到半个区间却当作完整证据。引用包括 CVE-ID、source_id、固定 observation_id、hash、来源 URL、modified 和 fetched_at。超预算整体返回413，不静默丢掉余下候选；缩小 limit 后重试。源异常/数据库故障是503，不伪装为空结果。其他写方法返回405。

Node 客户端可调用 `require('./cve/client').readContext({id:'CVE-2021-44228'})`；它只访问显式 loopback `CVE_BASE_URL`，限制响应大小/超时并拒绝重定向。MCP stdio 入口：

```json
{
  "command": "node",
  "args": ["D:/race/shujuku/scripts/cve_mcp.js"],
  "env": {"CVE_BASE_URL": "http://127.0.0.1:3100"}
}
```

仅暴露 `cve_read_context`，输入对应查询参数，其中 `limit` 为整数、两个布尔过滤为 boolean。MCP 不持有 DB 连接或模型 key，不导入、改事实、批准候选或执行检测动作。

`D:\projects2\pentest-tools` 的现有 TypeScript 工作台资料检索位于 `workbench/src/knowledge/tools.ts`，agent 工具及只读分类由 `workbench/src/agent/session.ts` 组装。本轮只做了只读核对；该项目尚未注册此工具，也未进行真实模型/渗透任务联调。后续由其控制器调用本机 HTTP 客户端/适配器，把工具显式列为只读并保留来源回执，容器不直接持有数据库凭据。MCP 入口可先供支持 MCP 的客户端独立使用。

## 验证与证据

```powershell
# 无数据库/无联网单元测试
node --test cve/test/unit.test.js

# 显式测试管理员连接；只创建/删除随机临时库与随机 NOLOGIN 测试角色
$env:CVE_TEST_DATABASE_URL = '<test-admin-connection>'
node --test cve/test/*.test.js
node scripts/cve_evaluate.js

# 额外、显式联网：固定 Git commit 的真实公开样本与可选 feed
node scripts/cve_live_smoke.js --allow-network
```

未设 `CVE_TEST_DATABASE_URL` 时 PG 集成测试明确 skip；评测/联网 smoke 则失败，不使用默认管理员连接。测试不会迁移或清空连接所指定的已有库。评测用三条原创合成 CVE、六条来源记录、16个固定预期查询；这验证接口与候选集合，不代表真实检索质量。联网 smoke 只导入一个已知 CVE 的少量来源记录到临时库，结束后删除；失败会保留失败状态并非零退出。

报告输出至 Git 忽略的 `artifacts/cve/`。独立 [CVE CI](../.github/workflows/cve.yml) 在 Node 22/24、PG16 上运行 fixture/DB/MCP 回归与合成评测，不依赖外网漏洞源。具体本次实际结果、未完成项与同步信息见 [STATUS.md](STATUS.md)。
