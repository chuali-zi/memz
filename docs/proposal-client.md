# 外部进程提交候选

`scripts/proposal-client.js` 是本机公开演示账号的最小写入接入，不调用模型。它处理登录、CSRF、候选写入和会话退出；只提交候选，绝不自动批准或修改来源。默认member身份。来源必须先通过已有界面/API创建，随后显式传入该项目的来源ID，不按标题猜测或自动抽取内容。

## 标准输入与库接口

在已启动的本机演示服务旁运行：

```sh
node scripts/proposal-client.js --stdin <<'JSON'
{"projectId":1,"sourceId":2,"subject":"项目","predicate":"截止日","value":"15号","expectedVersion":1,"idempotencyKey":"my-local-proposal-001"}
JSON
```

这是合成种子示例；运行前核对来源2的原文和当前版本。示例会新增一个候选，保留在选定数据库。新事实expectedVersion为0；已有事实使用上下文读取返回的版本。提交成功不证明版本仍最新，版本冲突在批准时由数据库事务检查。负责人在页面“候选与审批”中核对来源后批准或驳回；批准后再调用context-client读取上下文。

输入只能包含上述七个字段，不接受凭据、审批操作或任意URL字段。一个JSON对象后关闭stdin；限16KiB、5秒。账号配置通过MEMZ_USERNAME、MEMZ_PASSWORD，地址通过MEMZ_BASE_URL；默认member/demo-member和http://127.0.0.1:3000。只接受HTTP回环根地址，不携带内嵌凭据、不跟随重定向，不适用于公开或生产服务。

库调用：`const {submitProposal}=require('./scripts/proposal-client'); await submitProposal({baseURL,username,password,proposal})`。proposal为同一个七字段对象。库与命令行使用同一验证、写入和退出流程；每个HTTP请求最多5秒，正常流程总预算15秒，退出另限5秒；成功响应读取上限64KiB。未增加外部依赖。

## 回执与重试

成功时stdout只输出JSON，包含candidateId、sourceId、expectedVersion、statusAtCreation、currentStatusNotRead、autoApproved和sessionCleanup。statusAtCreation固定pending，是创建回执，不是重新查询后的当前状态：如果负责人已批准，重放原幂等键仍会得到最初回执。请从候选列表核对最新状态，不把pending回执当作“仍未批准”的证明。

幂等键必须由调用者生成并在发起写入前保存。本客户端不会自动生成新键或自动重试。结果不确定时保持项目、账号、来源、版本、文本和原键不变再人工重试；相同键不同内容返回409，不覆盖原记录。键范围受服务端项目、账号和操作约束，换账号不再是同一重试。修改内容应先核查原候选，不能当成原请求的安全重放。

失败时退出码1，stdout为空，stderr只包含固定code、outcome及可选HTTP status，不输出密码、cookie、CSRF或服务端原始错误。

| outcome | 含义 | 下一步 |
| --- | --- | --- |
| not_attempted | 客户端尚未调用候选写入 | 修正输入或登录配置 |
| rejected | 本次候选HTTP请求返回4xx | 核对权限、来源及409原因；不推断历史请求未成功 |
| unknown | 发起候选请求后响应丢失、5xx或回执无法验证 | 先核实状态，必要时以原参数和原键重试 |

已验证创建回执后，即使退出会话失败，仍输出成功回执并标记sessionCleanup=logout_failed，避免将已知成功写入误报为失败。会话可能保留到服务端过期，不自动重复业务写入。

## 实际验证与范围

PostgreSQL集成测试执行真实子进程，覆盖首次提交、同键重放只产生一条候选及一次propose审计、viewer/跨项目403、跨项目来源400、同键异内容409、输入错误、负责人批准后回执重放、旧版本新提议在批准时409，以及真实提交后人为丢弃响应再用原键恢复。单位测试验证非本地地址/坏输入在登录前拒绝、响应大小上限、无自动重试和退出失败回执。

来源绑定和权限由既有API与数据库约束执行；此客户端不自动创建来源，不把来源创建和候选创建宣称为原子事务。它不提供模型推理、语义抽取、自动验真、后台重试、持久任务队列或生产认证。
