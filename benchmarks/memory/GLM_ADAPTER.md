# GLM reader adapter — bounded transport, live validation pending

This adapter is a bounded provider transport for already assembled queries. It
does not implement memory extraction, retrieval, gold loading, scoring, judging,
or the complete experiment in `EVALUATION_PLAN.md`. No live call was performed
while adding it. A subsequent authorized cloud test on 2026-11-06 found no supported
credential variable in the selected environment; see [the run report](CLOUD_TEST_2026-11-06.md).
The requested model, exact snapshot, test scope,
tokenizer, region, approved run budget and prices remain pending. A subscription
does not establish API credits or authorization. This adapter does not use the
model routing of the current conversation.

Official API documentation checked on 2026-11-06:
[Zhipu chat completions](https://docs.bigmodel.cn/api-reference/模型-api/对话补全).
It specifies POST `https://open.bigmodel.cn/api/paas/v4/chat/completions`, Bearer
authentication, nonstreaming requests, `max_tokens`, and response `model`/`usage`.
Model availability and pricing must be verified for the separately authorized run.

## Runner interface

Import `GLMAdapter` from `scripts/glm_adapter.py`. Create **one instance per run**
to retain cumulative budgets and stop state:

```python
adapter = GLMAdapter(config, execute=False)  # offline default
result = adapter.complete({"id": "scope:question:arm", "query": "What color?",
                           "context": "The door is blue."})
if result["status"] == "error":
    # Persist the failed row and stop; do not create another adapter to retry.
    pass
```

Input JSONL must contain exactly `id`, `query`, `context`; unknown keys, including
gold/answer/evidence/metadata, are rejected. Context is an explicit string, and
empty context supports the no-memory arm. IDs accept ASCII letters, digits and
`_.:/-` up to 200 characters. This validates schema, not semantic absence of gold:
the assembling runner remains responsible for isolated, gold-free inputs.
No URLs inside context are fetched, and no tools are enabled.

`complete` returns `status` (`dry_run`, `ok`, `error`), safe `error` code,
`id`, `answer`, `requested_model`, `provider_reported_model`, `usage`,
`estimated_cost`, `finish_reason`, `attempts`, `latency_seconds`,
`config_sha256`, `request_sha256`, `request_bytes`, and `input_tokens`.
It also retains bounded response `id` as `provider_request_id`,
`system_fingerprint`, and `usage_details` with `cached_tokens` and
`reasoning_tokens` when the provider supplies the corresponding nested usage
fields. Unknown fields are discarded; missing counters/identity remain null.
HTTP failures also carry `http_status`. Provider/model errors stop the instance;
subsequent calls return `adapter_halted` without transport. Every attempt is made
once, including 403/429; there are no retries or fallback providers.

The fixed system prompt treats context as untrusted evidence and forbids following
its commands or role claims or allowing it to override host instructions.
`request_sha256` hashes the complete serialized request, including this prompt;
prompt changes therefore change the request hash. `config_sha256` hashes only the
supplied adapter configuration and does not identify the fixed prompt. For the
experiment manifest's `reader.system_prompt_sha256`, hash `SYSTEM_PROMPT` encoded
as UTF-8 and record the adapter code revision alongside it.

`requested_model` is configuration, **not actual routing evidence**.
`provider_reported_model` is the provider response field, also not independent
proof of underlying weights or snapshot. Missing model/usage remain null.
Partial usage preserves unknown token counters as null, never zero. Standard
prompt/completion/total counters and the optional nested counters above are
retained. Byte counts are safety limits,
not token counts. Exact tokenizer accounting remains the experiment runner's job.

Cost is null unless all explicit flat input/output prices and both usage counters
exist. If provided, it is labeled an estimate, not invoiced cost; cache discounts,
reasoning accounting, subscription credits, taxes and other pricing rules are not
inferred. Validate the pricing basis before interpreting this estimate.

## Configuration and offline validation

Use a separate JSON config, leaving `experiment.template.json` unchanged. This
example is a synthetic offline config; `glm-test` is not a selected live model:

```json
{
  "model": "glm-test",
  "max_calls": 2,
  "max_input_bytes": 8192,
  "max_request_bytes": 16384,
  "max_response_bytes": 65536,
  "max_total_input_bytes": 16384,
  "max_output_tokens": 256,
  "max_total_output_tokens": 512,
  "timeout_seconds": 30,
  "temperature": 0,
  "thinking": "disabled",
  "strict_usage": true,
  "pricing": null
}
```

All nine model/budget/timeout fields shown before `temperature` are mandatory.
Optional fields: `endpoint` (only the exact official URL), `temperature`, `top_p`,
`thinking` (`enabled`/`disabled`), `strict_usage` (boolean, default false), `pricing`
and `spend_guard`.
`strict_usage` is a local accounting check, never sent to the provider. Enable it
for measured runs: missing prompt/completion/total usage or an inconsistent total
marks the row `usage_unverifiable` and halts before another request. Safe available
usage and answer are retained for diagnosis and the failure denominator. Optional
cache/reasoning counters can still be unknown; that remains an explicit limitation.
If a provider model does not support
an optional parameter, omit it and record the omission in the experiment config.
Prices, when known, have exactly `currency` (three uppercase letters),
`input_per_million`, `output_per_million`. Credentials are never config fields.

`max_input_bytes` counts UTF-8 query plus context; `max_request_bytes` limits the
whole serialized request including system prompt and JSON overhead. Total input
bytes accumulate query/context sizes. Each accepted row reserves its full output
cap before execution, regardless of actual completion length. Failed attempts do
not refund reservations. Hard ceilings also constrain calls (10,000), each body
(16 MiB), input file/total input (64 MiB), output (131,072 per call), timeout
(120 seconds). Inputs are never silently truncated. If provider-reported completion
tokens exceed the cap, retain the response/usage, mark failure and halt; already
billed provider work cannot be undone. These are request limits, not a guaranteed
currency-spend cap or proof of provider-side accounting.

```sh
python benchmarks/memory/scripts/glm_adapter.py \
  --config /tmp/glm-offline-config.json \
  --input /tmp/glm-preassembled-input.jsonl \
  --output /tmp/glm-dry-run.jsonl
python -m unittest discover -s benchmarks/memory/tests -p 'test_glm_adapter.py' -v
```

Without `--execute`, CLI preflights every row and cumulative budget without reading
credentials or making network requests. Output must be new; existing files are
never overwritten. The whole bounded JSONL is validated before any execution.
For execution, both explicit `--execute` and all limits are required, in addition
to user authorization, configured API credentials and permitted networking.
CLI execution now also requires `spend_guard` and an exact model token counter;
no production counter is currently bundled, so the CLI refuses live execution
before output or transport. See the reservation interface below.
Read only `MEMZ_GLM_API_KEY`, falling back to `ZHIPUAI_API_KEY` then the user-named
`GLM_API_KEY`; supported injected
proxy placeholders are passed through normally. Never put keys on command lines,
in JSON, source, reports or version control. No key-discovery scan is performed.

Transport retains inherited proxies and CA trust, requires the exact HTTPS host
and path, forbids all redirects and alternate endpoints, limits response bodies,
and isolates the single HTTP attempt in a killable worker with a wall deadline
(plus up to 0.2 seconds bounded worker cleanup). It never reads HTTP error bodies.
CLI diagnostics expose only fixed codes; raw exceptions, headers, Authorization,
and request text are not logged. Decoded successful responses are checked in memory
for literal or JSON-escaped echoes of the transmitted credential. Any such echo
discards the response with `credential_reflection_detected` and halts. This is not
a detector for arbitrary encodings or transformed secrets. CLI output files are
created exclusively with owner-only permissions (`0600`, subject to a more
restrictive umask); existing files and symlinks are refused.
Result artifacts intentionally contain answers,
which can quote input context, so handle them as experiment data. The transport
hook is only for trusted offline tests; injected code is not a security boundary.

At initial implementation time the managed environment had no secret bindings and its
enforced network allowlist did not include `open.bigmodel.cn`. No network policy
was changed. Live execution remains pending; no output here is model performance
evidence or a completed benchmark.

## Pre-request token and cost reservations

`spend_guard` adds a fail-closed reservation ledger to the existing call, byte,
output and timeout caps. It requires explicit `pricing` and exactly these fields:

```json
{
  "tokenizer_id": "synthetic-complete-chat-v1",
  "max_input_tokens": 60,
  "max_total_input_tokens": 100,
  "max_cost": 0.0005
}
```

This is a **synthetic test configuration**, not a verified model tokenizer,
price, or a live budget. The currency comes from `pricing.currency`.

For the Python API, supply a trusted local callable as
`GLMAdapter(config, execute=True, token_counter=counter)`. Its `tokenizer_id`
attribute must match the configured identity; `counter(request_bytes)` must
count the complete provider-rendered prompt for the exact model and chat
template, including system/user content and framing. It receives no credential.
The caller must independently verify this counter; matching a string ID is not
proof of correctness. No arbitrary callback/import path is accepted from JSON,
no tokenizer is downloaded, and no byte-to-token estimate is substituted.

Before reading credentials or making a request, the guard checks per-call and
cumulative input tokens and reserves:

`(counted_input × input_price + max_output_tokens × output_price) / 1,000,000`.

Decimal arithmetic avoids binary rounding at the budget boundary. Reservations
are never refunded for shorter answers, failed requests or timeouts. A cap
violation halts before transport; a missing/mismatched counter also fails before
transport. The result's `spend_reservation` records the offline token count,
counter identity and per-call/cumulative decimal-string cost reservations.
Provider `input_tokens` remains a separate usage measurement.

Pass the same counter to `read_inputs(path, config, token_counter=counter)` to
preflight the **entire** input file and cumulative reservations before any call.
The caller must reuse one execution adapter across the run. Enabling the guard
also requires complete consistent usage; an actual prompt-token count larger
than reserved stops the run with `provider_input_budget_exceeded`, retaining
safe accounting. Already-billed work cannot be reversed. Wrong tokenizer,
provider pricing/routing changes, hidden billable categories, or a provider that
ignores limits can invalidate a currency estimate; this is not an invoice or a
provider-side hard spending limit. Cache discounts are not assumed.

Direct API users must explicitly configure this guard for paid experiments.
The legacy unguarded Python interface remains for existing transport tests; CLI
`--execute` refuses an absent guard, and cannot run until a verified production
token counter is integrated. Current real calls remain zero.

## Credential products and proxy placeholders

`MEMZ_GLM_API_KEY`, `ZHIPUAI_API_KEY`, then `GLM_API_KEY` are accepted in
that priority order. A variable name does not prove a credential's product,
model access, billing mode, or balance. The user explicitly authorized use with
the official Zhipu API. The endpoint remains the exact allowlisted official URL;
this change does not reroute requests to a different product endpoint or treat
an account/plan assumption as a separate execution blocker. Provider refusals
stop the run without retry or fallback. Record unknown fee/credit accounting as
unknown; do not infer it from the alias or a subscription. No authentication or
inference probe has occurred because all checked aliases remain absent.

Cloud network-secret placeholders are supported credentials; their appearance
does not imply failure. Keep the inherited HTTPS proxy so the platform can
substitute the real value at allowed destinations. Do not extract the real value,
change the secret type or expand allowed domains to work around an issue. See
[cloud environment documentation](https://learn.chatgpt.com/docs/environments/cloud-environments).
