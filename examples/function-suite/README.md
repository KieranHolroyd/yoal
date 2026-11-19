# function-suite

One Yoal Function that touches every system a function can reach, plus the scripts to provision it
and test it from outside. It is ordinary Workers code with a `wrangler.jsonc`, so the same project
runs under `wrangler dev` and on Yoal; the checks inside it are the same in both places.

| Piece | What it is |
| --- | --- |
| `src/index.ts` | `fetch` (router), `scheduled` (cron) and `queue` (three consumers) handlers |
| `src/checks.ts` | The in-Worker suite: one check per binding, run in parallel by `GET /api/suite` |
| `src/objects.ts` | Durable Objects: `Counter` (SQL, storage API, alarms) and `ChatRoom` (hibernating WebSockets) |
| `src/toolbox.ts` | `Toolbox`, a named entrypoint bound back into the Worker for JS RPC |
| `src/report.ts` | Sends errors to Yoal app errors through `SENTRY_DSN` without a Sentry SDK |
| `public/` | Static assets: a page that runs the checks, a chat room and a counter |
| `companion/` | A second, stateless function (`function-suite-companion`) for the `app` binding |
| `scripts/provision.ts` | Creates storage, Postgres, broker, queues, event rule, secret; enables app errors; deploys both |
| `scripts/suite.ts` | Black-box test: edge, every binding, DOs, queues/events end to end, load, control plane |

## What it covers

| System | How |
| --- | --- |
| `vars` (text + JSON) | `SUITE_GREETING`, `SUITE_CONFIG` |
| Secrets | Project secret `SUITE_SECRET`; only its SHA-256 leaves the isolate, compared with the provisioned digest |
| Static assets | Caddy serves `public/` first; `run_worker_first: ["/api/*"]` is proven by `public/api/shadow.txt`; `env.ASSETS.fetch` |
| KV | put with metadata and TTL, get json, getWithMetadata, list, delete |
| D1 | batch insert, aggregate, `raw()`, and batch atomicity (a duplicate key rolls the batch back) |
| R2 | put with HTTP + custom metadata, head, get, ranged get, list, delete on the managed RustFS bucket |
| Cache API | `caches.default` and `caches.open()` put / match / delete (the `cache` binding) |
| Durable Objects | SQL counter (`RETURNING`), storage API, alarms, hibernating WebSockets; 50 concurrent increments with no lost updates |
| Hyperdrive | `postgres` over `env.HYPERDRIVE.connectionString` to the managed Postgres (direct port; PgBouncer requires TLS, which workerd's Hyperdrive client never speaks) |
| Analytics Engine | `writeDataPoint` on every request, cron run and check |
| Queues | send, sendBatch, retry → redelivery, delayed send, `max_retries` → dead-letter queue, consumed by the same function |
| Events | an R2 upload under `events/` → event rule → `suite-events` queue → consumer |
| Cron | `*/5 * * * *` records each run in KV and D1; the suite also runs it on demand through the control plane |
| Service binding | `env.TOOLBOX` (same Worker, named entrypoint, JS RPC) |
| App binding | `env.COMPANION` → the `function-suite-companion` project on the same node (fetch) |
| Egress | public `fetch()` works; loopback, metadata and RFC 1918 addresses are refused |
| Auth | `env.AUTH.verify()` rejects missing and malformed tokens (when one user pool is attached) |
| App errors | an unhandled error is reported through `SENTRY_DSN` and found again in the error list |
| Logs / tail | console output shows up in the project's runtime logs |
| Scale to zero | `--cold-start` waits past `idleStopSeconds` (60) and checks the next request cold-starts |
| Control plane | function view lists every binding type; test request, run-cron-now, broker test message, storage browser, event rule deliveries |

## Run it locally

`wrangler dev` runs the same workerd, with local simulators for KV, D1, R2, queues, Cache and
Durable Objects. The companion runs in the same session, so the app binding works too.

```sh
cd examples/function-suite
bun install
cp .dev.vars.example .dev.vars        # SUITE_SECRET for local runs
bun run pg:local                      # Postgres 18 on 127.0.0.1:55432 for Hyperdrive (Docker)
bun run dev                           # http://127.0.0.1:8787 (both workers, SUITE_LOCAL=1)
bun scripts/suite.ts --base http://127.0.0.1:8787 --local
```

`SUITE_LOCAL=1` skips what only Yoal has: storage events, the private-egress block, auth and app
errors. Trigger the cron locally with `curl 'http://127.0.0.1:8787/__scheduled?cron=*/5+*+*+*+*'`.

## Run it on Yoal

You need an API key that can create projects, storage, databases, brokers, event rules and secrets
(an org admin key is simplest).

```sh
export YOAL_URL=https://control.example.com
export YOAL_TOKEN=yoal_…
bun scripts/provision.ts              # idempotent; --help for options
bun scripts/suite.ts                  # reads the URL from .state.json
bun scripts/suite.ts --cold-start     # adds the scale-to-zero check (~2 min)
```

`provision.ts` reads resource names from `wrangler.jsonc` and creates or reuses, all on
`--placement` (default `edge`) so every binding stays on one node:

| Resource | Name | Bound as |
| --- | --- | --- |
| Projects | `function-suite`, `function-suite-companion` (runtime `function`) | — / `COMPANION` |
| Object storage | `function-suite`, bucket `suite-objects` (read-write grant) | `BUCKET` |
| Postgres | `function-suite` with PgBouncer | `HYPERDRIVE` |
| Broker | `function-suite` (NATS JetStream); queues `suite-jobs`, `suite-jobs-dlq`, `suite-events` | `JOBS` + consumers |
| Event rule | storage `function-suite/suite-objects`, prefix `events/` → `suite-events` | — |
| Secret | `SUITE_SECRET` (random; `.state.json` keeps only its digest) | `SUITE_SECRET` |
| App errors | enabled for the project | `SENTRY_DSN` |

It then deploys the companion and the suite with the real CLI
(`bun apps/cli/src/main.ts deploy`, or `--cli "yoal"`), so Yoal's own bundler and manifest path are
part of the test. You can also open `https://function-suite.<contentDomain>/` and press
**Run all checks**.

`suite.ts` exits non-zero on any failure and writes `.suite-report.json`. `WARN` marks checks that
depend on sampling or lag (broker stream listing, log delivery, load p95), not on correctness.

## Run it on a fresh node

`tests/e2e/function-suite.e2e.ts` installs Yoal from the checkout on a disposable Lima VM (or a CI
runner, or any machine over SSH), claims it, and runs `provision.ts` and `suite.ts --cold-start`
there. See [docs/TESTING.md](../../docs/TESTING.md#function-suite-on-a-real-node).

```sh
bun tests/e2e/function-suite.e2e.ts      # from the repository root
```

## Reading failures

| Symptom | Likely cause |
| --- | --- |
| Deploy: `Binding HYPERDRIVE … not attached` | The database is not attached to the project; re-run provision |
| Deploy: `Queue … already has a consumer` | Another project consumes `suite-jobs`/`suite-events` on this broker |
| Deploy: `COMPANION … has no workload yet` | Deploy the companion first (provision does) |
| `secret` digest mismatch | The secret was rotated; a new secret applies on the next restart or deploy |
| `hyperdrive` connect timeout | Database still starting, or on another node than the function |
| `queue-*` timeouts | The agent's consumer is not pulling: check the agent journal for the workload |
| `events` timeout | Event rule disabled or failing (see `event rule deliveries`), or RustFS webhooks not reaching the control plane |
| `egress` "private addresses answered" | The function host's network policy is not applied, which is a security bug |
| `cron` stale | The node's function scheduler is not running for this workload |
| `idle stop → cold start` says still running | The access log is not configured (scale to zero is skipped then), or traffic kept it warm |

## Notes

- Messages are sent with `contentType: "json"`. Yoal still delivers the default `v8` type
  base64-encoded, so JSON is the portable choice.
- KV, D1, Cache and Durable Objects are stateful bindings, so this function runs as one host (`replicas: 1`) until workerd cluster mode lands.
- D1 rows older than a day are pruned by the cron, so a long-running install stays small.
- `/api/cpu?ms=` (≤ 2 s) blocks the host's single event loop on purpose; it exists to probe the
  watchdog and CPU quota, not for load tests.
