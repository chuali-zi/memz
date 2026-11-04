# 数据字典与数据库设计说明

依据 `db/schema.sql`、`db/migrations/001-current-revision-integrity.sql` 和 `server.js`。类型为 PostgreSQL 类型；表中“必填”指 NOT NULL（含主键隐含），不代表 HTTP 必须传入。`int identity` 均为 `GENERATED ALWAYS AS IDENTITY`，应用不提供 ID。时间使用 `timestamptz DEFAULT now()`，表示事务起始时间，不应作为全局提交顺序；列表使用 ID 排序。

## projects：项目

| 字段 | 类型 | 必填/默认 | 含义与约束 |
| --- | --- | --- | --- |
| id | int identity | 是 | 主键 |
| name | text | 是 | 项目显示名；数据库未设唯一约束 |

## memberships：项目成员

| 字段 | 类型 | 必填/默认 | 含义与约束 |
| --- | --- | --- | --- |
| project_id | int | 是 | 外键 → projects.id；与 user_id 构成主键 |
| user_id | int | 是 | 演示账号 ID；没有独立 users 表 |
| role | text | 是 | CHECK：owner/member/viewer |

账户与密码在服务端合成账号表中，membership 只表达项目授权，不存储密码。`member_role(project_id)` 是固定 search_path 的 SECURITY DEFINER 查询函数，读取事务身份并返回该用户在项目中的角色，避免 RLS 查询 memberships 时递归。

## sources：证据来源

| 字段 | 类型 | 必填/默认 | 含义与约束 |
| --- | --- | --- | --- |
| id | int identity | 是 | 主键 |
| project_id | int | 是 | 外键 → projects.id |
| title | text | 是 | 来源名称；HTTP 上限150个 JavaScript UTF-16 code units |
| content | text | 是 | 原始文本；HTTP 上限4000个 UTF-16 code units |

UNIQUE(project_id,id) 支持同项目复合外键。来源正文是数据，不执行其中指令；没有对来源真实性进行自动验证。应用角色只有读取/插入权限，不能更新或删除来源。

## facts：当前事实键及指针

| 字段 | 类型 | 必填/默认 | 含义与约束 |
| --- | --- | --- | --- |
| id | int identity | 是 | 主键 |
| project_id | int | 是 | 外键 → projects.id |
| subject | text | 是 | 主体；HTTP上限100个 UTF-16 code units |
| predicate | text | 是 | 属性；HTTP上限100个 UTF-16 code units |
| version | int | 是/0 | CHECK ≥0；当前版本 |
| current_revision_id | int | 否 | 指向当前修订；见下方复合约束 |

UNIQUE(project_id,subject,predicate) 定义业务事实键；UNIQUE(project_id,id) 用于修订关联。当前指针外键 `(project_id,id,version,current_revision_id)` → revisions 的 `(project_id,fact_id,version,id)`，同时绑定项目、事实和版本。CHECK 要求 version=0 时指针为空，version>0 时指针非空。

版本0用于首次审批事务中的创建占位。数据库本身允许版本0行持久存在；“首次创建在同一事务中完成修订”由服务实现。业务键按数据库文本相等规则区分，应用会 trim 输入但没有额外 Unicode 规范化；检索的大小写不敏感不等于事实键不区分大小写。

## candidates：待决策的事实候选

| 字段 | 类型 | 必填/默认 | 含义与约束 |
| --- | --- | --- | --- |
| id | int identity | 是 | 主键 |
| project_id | int | 是 | 外键 → projects.id |
| subject / predicate | text | 是 | 主体/属性，HTTP各上限100 |
| value | text | 是 | 候选值，HTTP上限1000 |
| source_id | int | 是 | (project_id,source_id) → sources(project_id,id) |
| expected_version | int | 是 | CHECK ≥0；提议基于的版本，0代表新事实 |
| proposed_by | int | 是 | (project_id,proposed_by) → memberships(project_id,user_id) |
| status | text | 是/pending | CHECK：pending/approved/rejected |
| created_at | timestamptz | 是/now() | 创建时间 |

UNIQUE(project_id,id) 供 revisions 引用。数据库 RLS 要求提出者与事务身份一致。应用只允许 owner 将 pending 候选批准/驳回；数据库的 UPDATE 权限并非列级，RLS只限定 owner，不能把API状态机说成数据库完整强制的状态机。

## revisions：不可由应用修改的历史修订

| 字段 | 类型 | 必填/默认 | 含义与约束 |
| --- | --- | --- | --- |
| id | int identity | 是 | 主键 |
| project_id | int | 是 | 同项目关联的组成字段 |
| fact_id | int | 是 | (project_id,fact_id) → facts(project_id,id) |
| version | int | 是 | CHECK >0；UNIQUE(fact_id,version) |
| value | text | 是 | 该版本批准的值 |
| source_id | int | 是 | (project_id,source_id) → sources(project_id,id) |
| candidate_id | int | 是 | UNIQUE；(project_id,candidate_id) → candidates(project_id,id) |
| approved_by | int | 是 | (project_id,approved_by) → memberships(project_id,user_id) |
| created_at | timestamptz | 是/now() | 修订创建时间 |

还存在 UNIQUE(project_id,id) 和 `(project_id,fact_id,version,id)` 唯一键/索引，用于同项目引用及当前指针约束。candidate_id 唯一，防止一个候选关联多条修订。RLS要求插入者为 owner 且 approved_by 与身份一致；应用角色没有 UPDATE/DELETE 权限。管理员仍能修改，不能称为密码学防篡改账本。候选值与修订值相同、批准状态同步由审批事务保证，不是外键自动比较文本。

## audit：操作记录

| 字段 | 类型 | 必填/默认 | 含义与约束 |
| --- | --- | --- | --- |
| id | int identity | 是 | 主键 |
| project_id | int | 是 | 外键 → projects.id |
| actor_id | int | 是 | (project_id,actor_id) → memberships(project_id,user_id) |
| action | text | 是 | 应用写入 seed/source/propose/approve/reject；数据库未限定枚举 |
| detail | text | 是 | 可读说明文本，没有结构化候选外键 |
| created_at | timestamptz | 是/now() | 记录创建时间 |

应用角色无 UPDATE/DELETE 权限；插入要求 owner/member 且 actor_id 与事务身份一致。审计与业务写入同事务，回滚时一起撤销。接口仅返回最近100条，不代表数据库只保存100条。

## 权限、索引及取舍

| 对象 | SELECT | INSERT | UPDATE | DELETE |
| --- | --- | --- | --- | --- |
| projects / memberships | 项目成员 | 不授予 | 不授予 | 不授予 |
| sources | 项目成员 | owner/member | 不授予 | 不授予 |
| candidates | 项目成员 | owner/member，身份匹配 | owner | 不授予 |
| facts | 项目成员 | owner | owner | 不授予 |
| revisions | 项目成员 | owner，身份匹配 | 不授予 | 不授予 |
| audit | 项目成员 | owner/member，身份匹配 | 不授予 | 不授予 |

以上是 GRANT 与 RLS 的共同效果。应用连接非 owner、非超级用户、无 BYPASSRLS；它能设置自身事务身份，所以泄漏数据库凭据后不能靠此机制阻止伪装用户。数据库管理员属于可信边界。

主键/唯一约束自动生成 B-tree 索引，复合外键使跨项目关联在写入时失败。外键本身不自动创建引用侧索引；当前未为所有查询额外建索引，也没有全文/向量索引。`position(lower(q) in lower(subject || ' ' || predicate || ' ' || value))` 是子串检索，不能据已有 B-tree 宣称查询已加速。下一步应结合受控规模和执行计划决定是否新增索引或进一步调整读取策略。

将来源、候选和历史分开，避免覆盖历史值；facts 保留当前指针与版本以简化当前读取，这是一项需维护一致性的冗余。审批事务、唯一键、复合外键和回归测试共同维护它。增量迁移不修改业务数据，锁等待或已有坏数据会使事务整体回滚，详见 README。

## idempotency_requests：创建回执

由迁移002添加；新schema直接包含。字段project_id(int)、actor_id(int)、operation(text，sources/candidates)、request_key(text，1–128个限定ASCII字符)组成主键；project_id引用projects，(project_id,actor_id)引用memberships。request_hash为64位小写十六进制SHA-256字符串；response为必填JSONB对象；created_at为必填timestamptz，默认now()。

应用只授予SELECT/INSERT，RLS要求actor与事务身份一致且是项目owner/member；不授予UPDATE/DELETE。主键提供范围唯一性，配合事务锁和业务事务实现重试，详见idempotent-creation.md。它保存原创建响应，不是候选实时状态；目前无TTL和自动清理。
