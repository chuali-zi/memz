# Instrumented Node22/24 service smoke pair

Two real HTTP/Express/PostgreSQL runs from clean fixed commit `ae30483466488893238332928c8ce25a5b10d3f9`, with start/end source checks and dependency hashes retained in both original reports. The Node24.22.1 load generator was fixed; only the explicitly chosen child application runtime changed, first Node22.23.4 then Node24.22.1. No external models, provider usage, costs, tokens or LoCoMo quality were measured. This is a single small instrumented engineering pair.

The original synthetic fixture has seed42, 512 generated records across two projects, each with an independent 1024-byte source (524288 source bytes in total). Both generation/actual logical content hashes are `564ce2e4d666ff078661606987e1e3870d80b05a2a08bf631691aacc6a69693c`. Page size is10, each normal concurrency level has32 samples; the five page positions and all fault/permission/recovery phases are retained. The old page25/n80 dirty-worktree report remains separate and unchanged.

| Application | Concurrency | Valid 200 / attempts | Goodput/s | p50 ms | p95 ms | p99=max ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| v22.23.4 | 1 | 32/32 | 174.39 | 5.56 | 6.95 | 7.55 |
| v22.23.4 | 4 | 32/32 | 370.11 | 10.88 | 13.29 | 13.47 |
| v22.23.4 | 12 | 32/32 | 454.57 | 21.16 | 36.18 | 40.04 |
| v24.22.1 | 1 | 32/32 | 165.84 | 5.87 | 7.04 | 7.37 |
| v24.22.1 | 4 | 32/32 | 374.30 | 9.90 | 14.63 | 14.76 |
| v24.22.1 | 12 | 32/32 | 597.34 | 17.95 | 25.79 | 28.22 |

Each run made exactly138 HTTP requests:126 successful reader snapshots,6 expected pool-timeout503,2 expected cross-project403 and4 authentication requests. There were zero unexpected/invalid samples. Each pool-fault phase retained all6 attempts near5 seconds; release was followed by12/12 successful same-session recovery requests. Fresh-process first reads were29.63ms/28.07ms, after authentication and after fixture creation/ANALYZE had already touched PostgreSQL/OS caches. They are not cold-cache observations.

Each run accounted6,962,052 application bytes; the pair used13,924,104 of16,777,216. The scope is HTTP request/response bodies and PG query UTF8/parameter JSON/result.rows JSON, including setup and cleanup; headers, authentication packets, PG wire, IPC, diagnostics and heap are excluded. All terminal reservations are0, with no denied, overrun or unmeasured operations. Pre-operation projection reservations protect this fixed fixture; unexpected chunks or driver materialization can be observed only after arrival and fail rather than imply a universal allocation guarantee.

Both child processes exited0 without force, owner/admin connections closed and random databases were dropped. Node22 execution/cleanup was6042.30/38.91ms, Node24 was6038.68/34.81ms; most execution time is the deliberate5-second fault phase and must not be interpreted as reader throughput. Both runs had77 resource samples. Sampled maximum child RSS was151060480B (144.06MiB) and98148352B (93.60MiB); their earliest resource observations already differed at123.55/71.10MiB. The absolute difference is not query-added memory, proof of a leak or a runtime causal conclusion. CPU counters are cumulative; phase differences use sampled boundaries and are not precise work attribution.

All collaborating agents had finished local tests before the pair, and only the dedicated test PostgreSQL container was observed; no other coordinated tests ran during the pair. Start/end other-database activity observations were1 connection/0 active, include the control administrator and exclude the current test database. These are two instants, not proof of continuous isolation; host load, OS/PG caches, GC/JIT and run-order effects were not controlled.

Read the limitations before comparing numbers: fixed22→24 order, one pair only, n32 (p95 is rank31 and p99 is the maximum), closed-loop coordinated omission, short phases, sampled rather than continuous peaks, and measurement overhead. Every PG result is JSON-serialized again for the byte ledger; HTTP hashing/validation/synchronous raw-file writes also add work. These are instrumented-profile results, not bare production latency/RSS, a stable tail/SLO, maximum capacity, a disabled-guard control, or evidence for changing languages/frameworks. No runtime default or technology stack was changed from this pair.

Reproduce only in a new coordinated window with the fixed source commit and documented trusted runtime paths: see `docs/reader-capacity.md`. Each run creates a fresh random test database and output directory. Do not automatically retry a failed run or rewrite archived samples.

The two subdirectories contain byte-for-byte original `report.json`, `requests.jsonl` and `resources.jsonl`. SHA256SUMS covers these and this explanation. It is an integrity manifest, not a digital signature or external authenticity certificate.
