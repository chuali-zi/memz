# 外部进程创建来源并绑定候选

来源客户端 `scripts/source-client.js` 支持库函数createSource和一次性标准输入。它与proposal-client复用write-client的本机地址限制、登录/CSRF、超时、响应限额、退出及固定错误合同。仅调用来源创建接口，不下载URL、不解析文件、不生成候选、不自动批准。

## 两步完整流程

在独立本机演示项目中，先把合成输入和稳定键保存到source-intent.json（每个新意图生成自己的键；重试不得重建或修改文件）：

```json
{"projectId":1,"title":"外部会议纪要（合成）","content":"本次截止日为18号。","idempotencyKey":"my-local-source-001"}
```

执行并在成功时保存回执，避免失败重试覆盖上一份有效回执：

```sh
node scripts/source-client.js --stdin < source-intent.json > source-result.tmp && mv source-result.tmp source-receipt.json
```

非零退出时停止后续流程，按stderr的outcome核对/重试。成功回执包含projectId和sourceId；接入者读取它们后，将来源ID写入单独保存的proposal-intent.json。示例中的SOURCE_ID必须替换为本次回执整数，subject应使用本次唯一演示主体；不要照抄已有项目的版本：

```text
{"projectId":1,"sourceId":SOURCE_ID,"subject":"外部演示-本次唯一名称","predicate":"截止日","value":"18号","expectedVersion":0,"idempotencyKey":"my-local-proposal-001"}
```

```sh
node scripts/proposal-client.js --stdin < proposal-intent.json > proposal-result.tmp && mv proposal-result.tmp proposal-receipt.json
```

负责人随后在既有页面核对来源原文并批准；外部读取方通过context-client读取批准后的版本。来源和候选必须属于同一授权项目，绑定的是ID而非标题。默认member只能写其所属项目；viewer或非成员由服务器拒绝。该流程不改变数据库授权规则。

库接口：`const {createSource}=require('./scripts/source-client'); await createSource({baseURL,username,password,source})`，source即四字段对象。结果只提供来源ID及创建回执标记，不把原文或凭据输出到stdout。candidateCreated=false与autoApproved=false明确表示本次未执行其他业务动作。

## 部分完成与幂等边界

这两步不是一个原子事务。来源创建成功、候选失败时，来源保留：保存第一步回执，修复第二步原因后按原意图重试，不重新生成来源键，也不自动删除来源。来源响应丢失时，先以同项目、账号、标题、正文和原键重试取得原ID，再进行候选步骤。不同账号、项目或操作不是同一个幂等范围；两个步骤分别保存自己的稳定键。

错误合同、退出失败和凭据配置同[候选客户端](proposal-client.md)：not_attempted表示尚未尝试业务写入，rejected表示本次4xx拒绝，unknown表示写入结果可能不确定。已验证回执后退出失败仍返回回执及logout_failed，不自动重复业务写入。调用者应显式处理非零退出，不把空stdout视为“没有创建”。

来源标题最长150、正文最长4000个UTF-16代码单元；拒绝NUL和未配对代理字符，沿用服务端首尾空白规范化。标准输入和编码后请求体均限16KiB，不能只按字符数推算JSON字节大小。stdin限5秒，单HTTP请求最多5秒，业务总预算15秒，退出另限5秒，响应读取限64KiB。仅支持HTTP回环根地址和公开演示账号，不是生产凭据或远程公开部署方案。

## 验证

真实Node子进程在随机临时PostgreSQL库执行来源→候选→人工批准→当前事实链路；核对来源及候选同键重放仅各生成一次记录/审计、viewer/非成员拒绝、跨项目来源不可绑定、同键异正文409、真实提交后合成响应丢失的恢复，以及第二步失败后来源仍存在。单位测试验证非法/超限内容在登录前拒绝、回执原文不匹配时结果不确定。所有数据为合成，不声称自动验真或智能抽取。
