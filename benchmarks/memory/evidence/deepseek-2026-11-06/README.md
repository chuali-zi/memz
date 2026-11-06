# 原创合成实验的可复核证据

这些输入、gold、模型输出和测试日志均属于Memz原创合成场景；不包含第三方基准、用户数据、认证头或API密钥。与本目录外部数据的忽略规则不同，本证据明确纳入Git以支持复核。

- `dev-export/`、`dev-run/`、`dev-summary.json`：最初四组56次开发调用，源码8212417。
- `dev-history-export/`、`dev-history-run/`、`dev-history-summary.json`：新增历史组14次开发调用，报告如实标记未提交状态。历史提示格式尚无最终before/limit说明。
- `heldout-export/`、`heldout-run/`、`heldout-summary.json`：最终五组280次调用，干净提交ff47b7c；输入含开发和留出两部分，runner只发送配置指定的heldout部分。
- 每个export保存`inputs.jsonl`（只有id/query/context）、独立`gold.private.json`和`export.json`。private表示流程隔离，数据是公开合成数据；模型runner不打开gold。
- 每个run保存固定config及完整calls.jsonl；包含provider模型/请求ID、输出、usage、hash、延迟和失败字段，不含HTTP认证信息。
- `preflight.json`：1次真实连通性请求回执，不计入350次正式评分。
- `system/`：ff47b7c干净工作树的102个核心及9个迁移测试原始TAP与哈希报告。
- `python-tests-final.log`：52个离线Python测试。
- `transport-six-arms.json`：6组本地HTTP实验360条测量及预热协议，未调用模型；source中的dirty/hash如实记录。
- `SHA256SUMS.json`：除清单自身外的所有文件哈希。

不联网重算留出成绩（输出必须是新文件）：

```sh
python benchmarks/memory/scripts/deepseek_score.py \
  --export benchmarks/memory/evidence/deepseek-2026-11-06/heldout-export \
  --run benchmarks/memory/evidence/deepseek-2026-11-06/heldout-run \
  --output /tmp/memz-heldout-recomputed.json
```

验证文件清单：

```sh
python - <<'PY'
import hashlib,json,pathlib
root=pathlib.Path('benchmarks/memory/evidence/deepseek-2026-11-06')
manifest=json.loads((root/'SHA256SUMS.json').read_text())
actual={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest()
        for p in root.rglob('*') if p.is_file() and p.name!='SHA256SUMS.json'}
assert actual==manifest
print('All evidence hashes verified')
PY
```

provider请求无法保证将来逐token重现，模型名也不是固定权重快照。这里支持复核实际输出与计分，以及在同协议下重新实验；不保证云模型确定性。
