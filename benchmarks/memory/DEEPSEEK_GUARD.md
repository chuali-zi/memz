# Current DeepSeek execution gate

This is a subsequent transport/accounting hardening change. It does not rewrite
the preregistered protocol, the 351 historical real calls, their original
receipts, results or authorization. No model was called to implement or test
this change. Both providers' existing fixed prompts remain unchanged.

`deepseek_run.py` still defaults to an offline dry run. It accepts the same
gold-free `id/query/context` JSONL, split/arm/repeat selection and preserves
planned-but-unexecuted rows. Its limits remain 400 calls, 64 KiB per serialized
request, 12 MiB aggregate serialized requests, 256 output tokens per request,
1 MiB response, 45 seconds and two concurrent requests, without retries. Input
file reading is bounded to 8 MiB plus one overflow byte. New output directories
and files are private (`0700`/`0600`, subject to a more restrictive umask).

## Paid execution requires a persistent budget

Use one `DeepSeekAdapter` instance per run.
Both `benchmarks.memory.scripts` package imports from the repository root and
the existing direct-script CLI entry points are supported without path injection.
`execute` and `simulation` accept
only actual booleans. A paid instance requires explicit `pricing` and
`spend_guard` with the same validation and Decimal reservation policy used by
GLM. Optional lower call/byte/output totals cannot raise the fixed ceilings.
For example, the following is **synthetic test configuration, not verified
DeepSeek pricing or a verified tokenizer**:

```python
budget = {
    "max_calls": 2,
    "pricing": {"currency": "CNY", "input_per_million": 2,
                "output_per_million": 4},
    "spend_guard": {"tokenizer_id": "synthetic-complete-chat-v1",
                    "max_input_tokens": 100,
                    "max_total_input_tokens": 200,
                    "max_cost": 0.003}
}
```

The Python API is `DeepSeekAdapter(budget, execute=True,
token_counter=verified_local_counter)`. The trusted counter receives the exact
serialized provider request, including system/user content and framing, before
credentials. Its `tokenizer_id` must match the guard, but matching that string
does not verify its correctness, model template or pricing basis. There is no
default production counter, tokenizer download, character-to-token fallback,
default price, or arbitrary callback/import path loaded from JSON.

The CLI accepts `--config` for a bounded budget JSON. It has no verified counter
loader; `--execute` without a guard fails with `spend_guard_required`, and a
guarded run without a verified counter fails with `token_counter_unavailable`.
These checks occur before any output directory, credentials or transport.
The current standalone CLI therefore remains closed for paid execution.
The legacy `complete()` function retains dry-run support; its unguarded paid
entry also fails closed. Multi-request callers must keep the persistent adapter
rather than constructing a fresh ledger to retry an error.

Within one instance, the halt check, input preparation, all cumulative limits,
token count and full Decimal fee reservation are protected by the same lock.
Admission failures set halt before releasing it. Transport runs outside that
lock. Subsequent errors also halt the instance; nothing refunds reservations
for failed, short or missing-usage responses. The runner preflights every
planned repetition with the same rules before creating files, then uses one
fresh persistent ledger for actual admissions. Manifest `reserved_output_tokens`
is the planned output ceiling, while per-call receipts record actual admission
reservations. Separate adapters/processes do not share a global budget.

Amount calculation, accumulation and comparison use a private 512-digit Decimal
context with fixed rounding, exponent bounds and traps, independent of a
calling thread's context. This covers the accepted finite numeric rate/budget
range, including `5e-324` mixed with `1e6` rates. Rates and counters are still
caller-verified conditions, and an estimate is never a provider invoice or an
absolute billing guarantee. Cache discounts, hidden charges and account credit
are not inferred.

## Receipts, halt and explicit simulation

Every executed response needs bounded integer prompt/completion/total counters
with a consistent total. Missing, invalid or over-reservation usage fails the
run, retains safe available diagnosis and consumes its reservation. Flat cache
hit/miss counts stay separate; when both are present this adapter requires
their sum to match prompt tokens. Optional nested cached/reasoning counters
are bounded by their corresponding totals and preserved in `usage_details`.
Missing optional measurements remain `null`, never zero; no reasoning token
count is inferred from text or from the request's disabled-thinking flag.

Responses are bounded and decoded before any text is retained. The shared
literal/JSON-escaped credential-echo check covers answers, identifiers and
unknown fields, including valid inner answer JSON and its escaped keys/values.
Duplicate inner keys cannot hide an earlier value: decoding preserves all
pairs for scanning while the original answer text is returned unchanged on
success. The scan allows at most 64 JSON parses, 16 MiB cumulative parse input,
32 MiB cumulative text, depth 32 and 100,000 nodes; exceeding a limit rejects
the whole response with `credential_scan_limit_exceeded`. It does
not detect arbitrary encodings or transformations of credentials. Provider and
transport exception strings are never persisted. Paid results and simulations
both contain `execution_mode`; output amounts are Decimal strings labeled as
configured flat-rate estimates.

Simulation is explicitly requested with `simulation=True`, `execute=True` and
a trusted fake `transport_fn`; the default real transport is rejected. It uses
only a synthetic credential and never reads environment credentials. Simulation
cannot establish real tokenizer, pricing or provider behavior. The programmatic
runner exposes the same test-only injections, without a CLI flag or JSON hook
that silently disables the paid guard.

The runner waits for the current pair before marking later rows `not_run`, with
zero attempts and no reservation. A failure can leave the other already
admitted request in flight; halt cannot revoke provider work or undo a bill.
There is no automatic retry. Returned model names are receipts, not independent
proof of weights or snapshot identity.

The targeted regression files are `test_deepseek.py`, `test_deepseek_guard.py`,
`test_glm_adapter.py` and `test_spend_guard.py`. They cover blocked sockets,
mock credentials/counters/rates/transports, concurrent admission and halt,
unknown usage, secret echo, preserved planned rows and hostile Decimal contexts.
