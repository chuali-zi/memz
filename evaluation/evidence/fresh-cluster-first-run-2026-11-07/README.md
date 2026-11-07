# Current schema first install on a fresh cluster

These two original JSON reports were copied byte-for-byte from this selected cloud. `SHA256SUMS` covers both payloads and this explanation. No raw initialization logs, environment values, authentication headers, SID/CSRF values or HTTP bodies are included. The only fixtures are public synthetic repository data.

The explicit test is `node test/first-run-cluster.js --execute`. It requires the complete checkout, locked dependencies, the local Docker socket and an already cached `postgres:16`; it never pulls. It is not part of the default core suite or the CI matrix. Work is limited to 180 seconds, cleanup to an independent 60 seconds, and the watchdog to 240 seconds while the event loop runs. Limits are 64 dispatched HTTP requests, 64 KiB per response, 1 MiB aggregate HTTP bodies and 8 MiB declared application accounting. The watchdog records UNKNOWN and cannot prove a daemon operation stopped.

| Original report | Exact clean source | Outcome |
| --- | --- | --- |
| initial-internal-failure.json | f9020407e9f09d42683ad5f67028774ae4d0e633 | Initialization acknowledged and container healthy, but required loopback publication absent; LOOPBACK_PUBLICATION_REQUIRED, 0 HTTP, 6843 bytes, 5662 ms. Doctor/context/story were not reached. All owned cleanup checks passed. |
| ordinary-bridge-pass.json | 1d630faf7c8500d6cab1ec54a3bd5e73dd39f0b3 | Passed: 47 HTTP (44×200, 2×403, 1×409), 17264 accounted bytes = 14758 work + 2506 cleanup, HTTP bodies 7450 bytes, 7042 ms. |

The passing run uses a unique Compose project, new named volume, dedicated ordinary bridge and an actually inspected 127.0.0.1 ephemeral publication. This bridge is not egress-isolated; no external request, network rule change, API call, image pull or connectivity probe was made. The earlier failure alone does not establish why publication was missing. The later fixture restores an ordinary bridge as in the production Compose connection pattern; it does not change the production Compose file. See [Docker's bridge documentation](https://docs.docker.com/engine/network/drivers/bridge/) for publishing semantics.

Before creation, both labels and exact resource names are checked absent. An extra executable observer performs a read-only role count before the official entrypoint executes the exact original 8005-byte schema, preserving CREATE ROLE. The passing marker confirms memz_app was absent before schema execution; after execution the application role is non-superuser/non-bypass/non-creator and four memberships are active. An added observer, copied mounts and resource overrides mean this is a derived fixture, not an unchanged production Compose invocation.

The actual doctor CLI returned BASIC_CHECKS_PASSED using application credentials. The actual application CLI returned live/ready 200. Original readContext returned seed 20号 v1 with provenance; original runDemoStory completed seven steps and current 15号 v2, old 20号 v1, stale 409, viewer 403 and other-project 403. Native HTTP is wrapped for single-origin dispatch, cancellation and bounded complete body materialization before the original client validators. There is no browser, MCP handshake, model, production identity or performance claim.

| Table | Before | After |
| --- | ---: | ---: |
| projects | 2 | 2 |
| memberships | 4 | 4 |
| sources | 4 | 7 |
| facts | 1 | 2 |
| candidates | 1 | 5 |
| revisions | 1 | 3 |
| audit | 1 | 11 |
| idempotency_requests | 0 | 7 |

Both runs stop their owned processes before Compose teardown and check project labels plus exact container ID, volume and network names. The passing CLI exited normally on SIGTERM, with no KILL or stderr. Cleanup left zero active commands and confirmed all owned resources absent. Creation uncertainty is not converted to success: configuration is retained even if current absence checks are empty. No prune or remove-orphans is used.

The clean runs used Node24.22.1, Compose2.40.3 and the actual cached image ID recorded in each report. Dependencies were linked individually from the already installed locked dependencies in this same cloud, not independently installed or downloaded. HEAD/dirty and the explicitly listed source hashes match before/after; these are not an independent whole-repository attestation. Accounting includes command arguments/output, CLI output and HTTP bodies; excludes mounted-file IO, internal PG, headers/wire, Docker daemon traffic, heap and serialization overhead. These are fixed small functional checks with observation cost and warm dependencies/image, not cold-start performance or an SLO. The earlier package-install test and historical Nov4 onboarding remain separate evidence.
