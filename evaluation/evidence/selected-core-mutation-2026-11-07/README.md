# Selected core mutation audit

Pinned commit: `947b416de6ac2327fafc6f54d1c28b61646100bc`. Node: `v22.23.4`.
Owned test execution ran 2026-11-07 21:50:34–21:50:37 UTC (3,220 ms), under the authorized 15-minute overall / 90-second per-run watchdogs. No timeouts or process signals occurred. No models, dependency installation, external service targets, main-tree changes, commits, or pushes.

Three selected baseline groups passed before any mutation: A 2/2, B 2/2, C 1/1. `BASELINES_GREEN` was written before the mutation loop. The name filters deliberately omit every unselected test; the TAP counts are **selected cases**, not whole-suite results. Full selected names and commands are in `summary.json`.

| Mutant | One semantic expression disabled | Actual targeted failure | Classification |
| --- | --- | --- | --- |
| M1 | `server.js`: stale expected-version comparison | Approval case line 42 returned HTTP 200 instead of 409; competing approvals also returned `[200,200]` instead of `[200,409]` | KILLED |
| M2 | `idempotency.js`: same-key/different-payload hash comparison | Creation conflict case line 58 returned HTTP 200 instead of 409 | KILLED |
| M3 | `db/schema.sql`: active-membership filter | Both actual INSERT/revoke/next-audit cases line 150 lacked expected SQLSTATE 42501 after owner COMMIT; this is a driver/RLS behavior assertion, not a function-source equality check | KILLED |
| M4 | `scripts/database.js`: COMMIT command confirmation | Swallowed SQL-error transaction case line 35 unexpectedly fulfilled instead of rejecting | KILLED |

Each JS mutant passed `node --check`; the SQL mutant successfully initialized its owned database and reached the target assertions, proving valid execution rather than an initialization failure. Every mutant was restored immediately afterwards and its SHA-256 matched the pre-mutation file before the next mutation. All failures are `ERR_ASSERTION` at the target behavior, with no failed hooks, cancellations, unsupported query observations, meter violations, watchdog termination, or unresolved cleanup. No survivor or invalid mutant was discarded. M4 stops on its first division-by-zero assertion failure; the later timeout/local-GUC checks passed in the baseline but are not independently claimed as mutation kills.

Resource counters recorded 63 HTTP requests and 175,727 bytes for SQL UTF-8, JSON parameters/result rows, and HTTP request/response bodies. The per-process preloader counters sum to 159,533 bytes; the remaining 16,194 bytes were included by the parent runner's `control()` counter for the two group-C CREATE/schema initializations. `parent-ledger.json` explicitly reconciles the two components without modifying the original summary. Counts exclude headers, errors, wire framing and heap allocation. Accounting happens after materialization and is **not a hard allocation bound**. The original runner deliberately bypassed work accounting for bounded terminal DROP cleanup; `verification.json` separately reconstructs 688 bytes for its nine acknowledged terminal DROP SQL/empty parameter/result inputs and records 442 bytes for the final metadata-only existence check. Accounted total: **176,857 bytes**, below 16 MiB. No cookie, CSRF token, auth header, raw SQL parameter, or response-body contents were logged by the observer.

Nine owned CREATE acknowledgements were tracked. Their native DROP acknowledgements succeeded; final independent `pg_database` metadata lookup found none of those nine names. The isolated worktree was removed; main remained clean at the pinned commit. `verification.json` records the final check at 21:53:06 UTC. The unrelated pre-existing `/workspace/memz-verify` worktree was untouched.

Evidence:

- `baseline_{A,B,C}.tap` and `M{1,2,3,4}.tap`: complete selected TAP.
- `M*.patch`: exact one-expression differences; all before/mutant/restored hashes are in `summary.json`.
- `*.PID.json`: per-process count-only observer metrics; `*.journal.jsonl`: native CREATE/DROP acknowledgements for owned random names.
- `runner.js`, `preload.js`: exact executed scripts; `verify-cleanup.js`: final metadata check, with `verification.json` output.
- `*-engine-approval-intent-resources.json` files are opportunistically copied legacy A-suite output. Only the `baseline_A`, `M1`, and `M2` versions belong to their named execution; copies for B/C/M3/M4 are stale A-suite output and **must not be used as those groups' evidence**. The authoritative cross-group counters are the PID metrics and summary.
- `SHA256SUMS`: evidence-file checksums, excluding itself.

To reproduce after a newly coordinated PG window, retain main at the pin with its existing dependencies and public synthetic loopback PG fixture. Copy this directory's `preload.js` to `/tmp/memz-mutation-preload.js`, then invoke this directory's `runner.js` using `/workspace/.memz-toolchains/node22/bin/node`. The runner creates a new random detached worktree/evidence directory and cleans only its native-acknowledged random databases. It runs the same three baselines first. It never installs packages or modifies main. The final metadata check is separately reproducible with `node verify-cleanup.js` for this run's names.

This is evidence that these selected behavior oracles detect four specific regressions. It is not exhaustive mutation coverage, a global security claim, a performance sample, or a claim about model quality.
