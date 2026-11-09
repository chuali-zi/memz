# 检索树第一版验证证据

日期：2026-11-09（Asia/Shanghai）。本目录仅含原创合成数据的测试/测量报告，没有数据库连接、密钥或第三方漏洞原文。运行器和当前产品边界见 [状态记录](../../STATUS.md)、[检索树契约](../../../docs/cve-retrieval-tree.md)。

TAP 归档仅将 PowerShell 捕获产生的 CRLF 换行统一为 LF，测试输出内容、计数和耗时保持原样；捕获文件保留在本机 `artifacts/cve/`。校验和针对这里实际归档的字节。

- `tests-tree-node22.tap`、`tests-tree-node24.tap`、`tests-tree-node25.tap`：Node v22.23.4、v24.22.2、v25.6.1 分别运行 `node --test --test-reporter=tap cve/test/*.test.js`，各38/38通过，0失败/跳过/取消。包括随机临时库中的导入/同步、只读HTTP/MCP、完整导航、投影迁移与专用读者/导入角色。
- `evaluation.json`：`node scripts/cve_evaluate.js` 的16个合成候选集合用例全部通过，3条CVE、6条来源记录。
- `tree-evaluation.json`：`node scripts/cve_tree_evaluate.js` 的4组查询检查通过。2000条合成CVE，100个web候选、1900个other候选；专用SELECT-only角色、单个持有连接、串行HTTP，每组1次热身与20次测量。包含原始耗时、响应字节、三份执行计划和相关源文件LF规范化SHA-256。
- `SHA256SUMS.json`：上述报告的原始字节校验和；本目录 `.gitattributes` 保留证据字节。

PostgreSQL为本机现有容器16.15。测试只创建/清理随机数据库与随机NOLOGIN角色；原Memz数据库未建立CVE schema。最终只读清理检查发现本轮测试前缀的数据库/角色均为0。

完整Git fixture回归需创建临时`.git`，本机sandbox首次执行对此拒写；最终完整套件通过受审查的扩展权限运行，未弱化用例或修改Git身份配置。本轮审查发现的原型键、NVD公告标签与版本证据缺口已修复，并纳入回归。

这些结果验证合成资料下的工程正确性和本机小规模热缓存延迟，不证明全量CVE覆盖、真实召回率、并发性能、自然语言能力、目标受影响或真实智能体任务效果。性能过程曾发现根查询的N²连接扫描，最终报告对应修复后的查询，不以历史结果推导生产加速比例。
