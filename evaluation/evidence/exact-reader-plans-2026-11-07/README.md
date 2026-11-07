# Original synthetic exact-reader SQL plans

This is the unchanged local report from clean commit `c3d7587d60aca2a94aecb924454ac1aca8fbf00b`, Node 22.23.4 and PostgreSQL 16.15. Its source-file hashes, dataset hashes, original plans and cleanup confirmation are retained. All data and accounts are explicitly synthetic; no provider or model calls occurred.

| Facts in target project | Metadata rows read | Complete metadata returned | Exact facts / proof rows / sources |
| --- | --- | --- | --- |
| 512 | 512 | yes, 512 labels | 1 / 1 / 1 |
| 4096 | 513 | no, empty labels | 1 / 1 / 1 |

The 4096-row exact check uses a known literal selector directly. The template client still refuses the incomplete 4096-row vocabulary. Each of the eight captured product data queries was explained twice (16 plans). The unique `(project_id,subject,predicate)` fact index was selected for both exact-selection samples at each scale, with default planner settings. Foreign-account API checks returned 403 and direct RLS queries returned zero rows. The random database was dropped.

These are warmed EXPLAIN ANALYZE samples, with other isolated tests running. They are neither HTTP latency/throughput measurements nor evidence of model quality, token savings, a production SLO or a technology-stack speed comparison. A sequential scan on the tiny source table is expected to be reasonable. Do not treat these instrumented samples as exclusive or cold-cache benchmarks.

Reproduction: `PLAN_DATABASE_URL=<isolated-test-admin> npm run eval:exact-plans`. See `docs/exact-reader-plans.md` for fixture and permission boundaries. Verify unchanged bytes here using `sha256sum -c SHA256SUMS`. The source code at the recorded commit is authoritative; later commits do not retroactively change this run.
