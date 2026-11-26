# Yoal — Logs Explorer

Status: **built, 2026-11-26.** Phases L1–L7 are built and merged; §11.1 lists what is built and what is not. The
mechanisms that were proposals LP1–LP12 are now **D243–D254** ([DECISIONS.md](./DECISIONS.md); §13 maps the old
numbers, which code comments still cite). Sections describe the system as built. §1 records the tree before the build
(verified 2026-11-25). Kieran settled the open questions on 2026-11-25 (§15). The lane briefs and merge order are in
[build-plan/LOGS-WAVES.md](./build-plan/LOGS-WAVES.md).

Related: [DESIGN.md](./DESIGN.md) §8 (observability), D15, D16, D101 (ClickHouse telemetry), D109 (alert rules),
D141 (log drains), D153 (pipeline logs), D243–D254 (this feature), [API.md](./API.md#logs-explorer), [APP-ERRORS.md](./APP-ERRORS.md), [SERVER-ERRORS.md](./SERVER-ERRORS.md),
[ALERTS.md](./ALERTS.md), [QUOTAS.md](./QUOTAS.md), [IAM.md](./IAM.md), [ASSISTANT.md](./ASSISTANT.md).

**Contents:** [0 Summary](#0-summary) · [1 Before the build](#1-before-the-build) · [2 Goals](#2-goals-and-non-goals) ·
[3 Record model](#3-one-record-model) · [4 Pipeline](#4-ingest-pipeline-and-stores) · [5 Sources](#5-sources) ·
[6 Query language](#6-query-language) · [7 Explorer UI](#7-the-explorer) · [8 Analysis](#8-analysis) ·
[9 Act on logs](#9-acting-on-logs) · [10 Cost and safety](#10-cost-retention-and-safety) · [11 Phases](#11-phases) ·
[12 Spikes](#12-spikes) · [13 Decisions](#13-decisions) · [14 Alternatives](#14-alternatives-considered) ·
[15 Risks and open questions](#15-risks-and-open-questions) · [Appendix: research](#appendix-research)

---

## 0. Summary

Every log line produced anywhere on the platform, from apps, builds, jobs, pipelines, databases, brokers, storage,
Kubernetes, functions, the edge and Yoal's own services, becomes one **LogRecord**. There is one **Explorer** to
search it, at `/logs` for a whole org and embedded, pre-scoped, on every resource page. It combines CloudWatch's
groups, Insights queries, Live Tail and pattern compare with Loki Drilldown's per-field volume breakdowns,
Datadog's facets and saved views, and Honeycomb's "what's different about this spike".

Five ideas carry the design:

1. **One record model, shaped like OpenTelemetry** (§3). Scope, severity number, body, attributes, resource, and
   trace and request IDs.
2. **SQLite stays the hot tail; ClickHouse becomes the search index** (§4). Ingest still writes SQLite, as it did
   before, so live tail and drains (D141) keep working without ClickHouse. A cursor **indexer** copies, parses,
   pattern-mines and redacts rows into a ClickHouse `logs` table. This is the same at-least-once cursor machinery
   drains use, so a ClickHouse outage only delays search. It never loses lines.
3. **One query language, compiled on the server** (§6). Datadog/Railway-style filters (`level:error service:api
   -path:/health "timeout"`) plus Insights-style pipe stages (`| stats count() by bin(5m), level`, `| patterns`).
   The grammar lives in `@yoal/contracts`, so the dashboard, CLI, MCP and assistant share one parser. Tenancy is
   ANDed in on the server, exactly like the D101 dashboard builder.
4. **One Explorer component** (§7) replaces the four viewers that existed before (`LogsPanel`, `ServiceLogs` and
   `PodLogs` are deleted; `JobLogs` is a thin wrapper that keeps pipeline step grouping). It has a time histogram you can brush to zoom, a facet sidebar, live tail, row context, and Stream,
   Patterns, Analytics and Compare modes.
5. **Logs you can act on** (§9). Queries become alert rules (a count threshold, or "a new pattern appeared after a
   deploy"), dashboard panels and log-based metrics, and every row pivots to its deploy, request, app error and
   node.

Without ClickHouse, the Explorer still runs, in a smaller "lite" mode over SQLite: scope, time range, built-in
filters, text search, histogram, `| stats count() by bin()`, live tail and context. Facets on parsed fields, regex,
patterns, most stats, Compare and Why? need ClickHouse, and the UI says so with a link to Settings → Telemetry. This keeps D101's "optional and fail-open" promise.

---

## 1. Before the build

What was in the tree before the build (verified 2026-11-25). The rest of this document describes what replaced it.

- **Five sibling SQLite tables of the same shape**:
  - `log_events` (runtime, build, system, job runs; migration 0005, and 0059 for `job_run_id`)
  - `service_log_events` (0017)
  - `broker_log_events` (0048)
  - `k8s_log_events` (0116)
  - `pipeline_log_lines` (0071)

  There is also `k8s_pod_logs` (0117) and ClickHouse `function_tail_events` (JSON blobs, 30 days). Every message is
  plain text with a four-value `level` and no attributes. Messages are capped at 16 KB, with ANSI stripped.
- **Capture.** Workloads write to journald. The helper reads `journalctl -o json` by cursor. The agent polls every
  2 s and POSTs to `/api/agent/logs`, and `LogService.append*` inserts. The builder and pipeline step runner POST
  their own lines.
- **Search** is `instr(lower(message), lower(q))`, a full scan (`packages/core/src/logs.ts:509`). The project REST
  API has no time range. `LogsPanel` only filters rows it has already loaded.
- **Retention.** `log_events` is kept for `logRetentionDays` (default 7) and **a global 500,000-row cap across all
  projects** (`logs.ts:29`), so one noisy project can evict everyone else's history. Pipeline logs have a fixed
  90 days, k8s lifecycle lines a fixed 30 days, and function tails 30 days.
- **Live tail.** Project logs use SSE (`projects/[slug]/logs/stream`), and every open tab polls SQLite every 700 ms.
  The other viewers poll over REST.
- **Not captured at all.** Yoal's own processes (agent, helper, builder, control plane, Caddy, zot, yoal-mail,
  ClickHouse), per-request edge logs (only 1-minute aggregates leave the node), console and cloud-shell sessions.
- **Not built, but documented.** The OTLP receiver (DESIGN §8, D16). There are no request or trace IDs anywhere,
  so an access-log spike cannot be joined to app lines.
- **Surfaces.** `GET /api/v1/projects/:slug/logs` plus per-service `…/logs` routes. MCP `get_logs`,
  `get_{database,broker,storage}_logs`. CLI `yoal logs` (no `--follow`), `yoal db|storage|broker|k8s|jobs|run
  logs` (with `-f`). Permission `logs:read` (org, project and environment scope).

[FEATURE-RESEARCH.md](./FEATURE-RESEARCH.md) listed "log warehouse" under *Do not build* in favour of export. That
row now excludes only APM and trace storage (D244). Drains and OTLP export stay, but an operator should not need a
second product to answer "what happened at 14:02".

---

## 2. Goals and non-goals

**Goals**

- Every line from every source, with one model, one query language and one UI, scoped by the same IAM.
- Find anything in a 24-hour project window in under 1 s, and draw the histogram in under 1.5 s (§12, S1).
- Live tail with end-to-end latency under 3 s (the agent's 2 s poll is the floor).
- From any spike, error, alert or deploy, reach the relevant lines in one click, and back again.
- Answer "what changed" without writing a query: patterns, compare, and field differences.
- Predictable cost: per-project quotas, retention tiers, exclusion and sampling you can preview, and redaction before
  anything is stored.
- Terminal and agent parity: the same grammar in the CLI, MCP and the assistant.

**Non-goals**

- Distributed trace storage and a span waterfall. Records carry `trace_id` and `span_id` so a trace store can join
  later, and so external trace tools can be linked.
- A general SIEM, including correlation rules across orgs.
- Replacing drains. Drains remain the way to send logs elsewhere (D141).
- A second log engine (Loki, VictoriaLogs and others; §14). ClickHouse is already the telemetry store.

---

## 3. One record model

`LogRecord` lives in `@yoal/contracts` and follows the OpenTelemetry logs data model, with Yoal's scope added.

| Field | Notes |
|---|---|
| `id` | Stable: `<table tag>:<seq>`, for example `le:48213` (`log_events`) or `lr:91` (`log_records`). Drains already promise a stable `id`. |
| `ts`, `observedTs` | Event time (parsed from the line when present, otherwise `observedTs`) and receive time, in epoch **milliseconds**, as every table stores them (ClickHouse `DateTime64(3)`). |
| `orgId` | Always set by the server. Platform records, and edge records whose host matches no project, use the sentinel `'platform'`, which no tenant boundary includes (§10.5). |
| `scope` | `{ kind, id }` where `kind` is `project · database · storage · broker · k8s · pipeline · function · edge · platform`. This plays the role of CloudWatch's log group. |
| `stream` | A finer stream inside the scope: deployment + replica, build, job run, pipeline job + step, pod, node service. This plays the role of a CloudWatch log stream. |
| `source` | `runtime · build · job · pipeline · system · access · otlp · audit · platform` |
| `severityNumber`, `severityText` | OTel 1–24. `trace/debug/info/warn/error/fatal` map to 1/5/9/13/17/21. |
| `body` | The message text, still capped at 16 KB. Structured OTLP bodies are stored as JSON text. |
| `attributes` | Per-record fields: parsed JSON or logfmt keys, `http.*`, and user keys from OTLP. |
| `resource` | `service.name` (project slug or service name), `deployment.id`, `host.name` (node), `container.id`, `k8s.*` |
| `traceId`, `spanId`, `requestId` | Extracted at index time (§4.3), or set by the source (OTLP, edge access records). |
| `patternId` | Drain template id, 16 hex characters (§8.1). |

The existing tables are not rewritten. An adapter maps each one onto `LogRecord`
(`packages/core/src/log-store/sqlite-sources.ts`), and new sources write a generic SQLite table, `log_records`
(migration 0142). It has no CHECKs on `kind` or `source`, which is the lesson of 0028. Folding the siblings into it is
a later migration (§15.5); it has not been done.

---

## 4. Ingest pipeline and stores

```
 node: journald / builder / step runner / OTLP / Caddy access file / platform units
        │  (POST /api/agent/logs; structured records: POST /api/agent/log-records)
        ▼
 control plane: LogService.append*  ── ingest guard: rules (D251) · quota (D251) · redaction (D252)
        │                         └──► in-memory tail bus ──► SSE (Explorer, yoal logs -f)
        ▼
 SQLite hot tail (log_events, …, log_records)  ── cursor ──► drains (D141, unchanged)
        │
        └── cursor ──► indexer: parse · severity · ids · multiline · patterns ──► ClickHouse yoal.logs
                                                                          └──► daily Parquet archive (D251)
```

### 4.1 SQLite is the hot tail (D244)

The write path stays where it was. SQLite holds a short window: 3 days by default when the search index is installed,
and 7 without it (per org, 1–14 days, D251). It serves live tail, context lookups and drains, and is what lite mode
searches. The global 500,000-row cap is gone: each scope keeps at most 100,000 newest rows per table
(`LOG_SCOPE_ROW_CAP`, D251). Kubernetes and pipeline lines keep their own fixed retention. A lite-mode read never
reaches back past the org's hot days on the hot-tail tables (the read starts at `now - hotDays`, with a `partial`
warning saying so), and `fields` summarises the built-ins in one GROUP BY scan. A ClickHouse read that fails falls
back to SQLite only when ClickHouse is unreachable; a query it stopped or refused (timeout, memory or row limits) is
an error, not a heavier rerun on the control plane. Every ingest path stores a record's `ts` at most 5 minutes
ahead of the control plane's clock (`capLogTs`), so a skewed node cannot pin lines above every real one.

**Concern (open).** Log rows sit in the platform state database, which Litestream streams. At high volume that
streaming replicates disposable data and competes with state writes. Spike S2 was meant to measure this and has not
run. If it is a problem, the log tables move to an attached `logs.db` that Litestream does not stream. The rows are
already disposable: drains and the indexer have read them.

### 4.2 The indexer feeds ClickHouse (D244)

The indexer (`packages/core/src/log-indexer.ts`) is a control-plane loop built like the drain worker
(`packages/core/src/log-drains.ts`), ticked on the primary from `hooks.server.ts`. It keeps one cursor per hot-tail
table in `log_index_cursors`, reads batches of up to 5,000 rows (up to 20 batches per table per tick, so a lagging
index catches up), enriches them, and inserts into `yoal.logs` with `insert_deduplication_token = <table>:<from>-<to>`.
A failed batch is retried over exactly the same range, so a replay is dropped by ClickHouse. It moves the cursor only
after ClickHouse acknowledges, with a conditional update so a second process never rewinds it. A table seen for the
first time starts 50,000 rows behind its newest row, so the indexer never reindexes years. A batch ClickHouse keeps
rejecting as malformed is skipped after a few attempts and recorded in `last_error`. It is fail-open: a ClickHouse
outage stalls the cursors, `lagMs()` grows and reads that reach the recent past carry an `index_behind` warning
(past 60 s). Live tail is unaffected. It is off where telemetry is not installed and behind `LOG_INDEX`.

`yoal.logs` as built (`logsTableSql` in `packages/core/src/telemetry.ts`):

```sql
CREATE TABLE yoal.logs (
  ts DateTime64(3), observed_ts DateTime64(3), id String,
  org_id LowCardinality(String), scope_kind LowCardinality(String), scope_id String,
  stream_id String, project_id String, deployment_id String, node_id LowCardinality(String),
  source LowCardinality(String), severity_number UInt8, severity_text LowCardinality(String),
  body String, pattern_id String,
  trace_id String, span_id String, request_id String,
  attributes Map(LowCardinality(String), String),
  resource Map(LowCardinality(String), String),
  INDEX body_text body TYPE text(tokenizer = 'splitByNonAlpha', preprocessor = lower(body)) GRANULARITY 1,
                                                    -- fallback when the server rejects it: tokenbf_v1 over lower(body)
  INDEX id_bf id TYPE bloom_filter(0.01) GRANULARITY 4,
  INDEX req request_id TYPE bloom_filter GRANULARITY 4,
  INDEX trace trace_id TYPE bloom_filter GRANULARITY 4,
  INDEX attr_keys mapKeys(attributes) TYPE bloom_filter GRANULARITY 4
) ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (org_id, scope_kind, scope_id, ts)
TTL toDateTime(ts) + INTERVAL 90 DAY      -- backstop; search retention is an explicit daily DELETE (D251)
SETTINGS non_replicated_deduplication_window = 1000, ttl_only_drop_parts = 1
```

`yoal.log_patterns` is a `ReplacingMergeTree(last_seen)` keyed by `(org_id, scope_kind, scope_id, pattern_id)`.
Attributes stay a `Map`; no hot keys are promoted to typed columns, and ClickHouse's `JSON` type was not adopted.
S1 did not show a need for either.

### 4.3 Enrichment, in index order

1. **Multiline join.** Continuation lines are joined to the previous line of the same unit and stream: lines that
   start with whitespace or a tab, `at …` frames, `Caused by:`, `Traceback (most recent call last):`, `File "…"`
   frames and `... N more`. A joined record is capped at 16 KiB and 200 lines, and flushes on a 1 s gap or at the end
   of a batch. This happens in the agent's drain (`apps/agent/src/log-drain.ts`), before shipping, because only it
   sees the exact unit order. The planned "line without a timestamp within 50 ms" rule is not built.
2. **Parse** (`packages/core/src/log-enrich.ts`). A body that is a JSON object, or logfmt with at least two `k=v`
   pairs, becomes attributes, flattened with dots (at most 64 keys, 4 KiB a value). The body becomes `msg`,
   `message`, `event` or `error` if one exists, and otherwise stays the original text.
3. **Severity.** Take the parsed `level`, `severity`, `lvl` or `log.level`, otherwise keep the level the line
   arrived with (the ingest heuristic), and map to an OTel number.
4. **IDs.** `trace_id` comes from `traceparent`, `trace_id`, `traceId` or `dd.trace_id`, and `span_id` likewise.
   `request_id` comes from `request_id`, `requestId`, `req_id`, `x-request-id` or `http.request_id`, which covers
   the `X-Request-Id` value Yoal injects at the edge (D248).
5. **Redaction** has already run at ingest (D252), so the indexer never sees secrets. `index_only` rules (D251) keep
   a record out of the insert here.
6. **Pattern.** A Drain template id (§8.1).

### 4.4 Live tail (D246)

Every `LogService.append*` path, including pipeline lines and Kubernetes pod logs, publishes the rows it inserts to an
in-process bus (`packages/core/src/log-tail-bus.ts`). Each SSE subscriber (`/api/v1/logs/stream`, used by the
Explorer and `yoal logs -f`) compiles its query once to a JavaScript predicate (§6.3) and receives only matching rows.
No subscriber polls the database any more. Reconnects resume by `Last-Event-ID`, a per-table seq vector, using a
SQLite catch-up read and then the bus. A tail can also start after a search page: from the page's `newer` cursor, or,
when the page had none (an empty window, or a lagging index), from its `tailCursor`, the hot-tail position taken
before the read. A subscriber that falls more than 2,000 lines behind gets a "sampled" marker and the newest lines,
like CloudWatch Live Tail. The bus is per control-plane process, which is correct with one active control plane.
The standby (CLUSTERING §6) starts with an empty bus and clients reconnect. There is no MCP tail.

Every subscriber's predicate runs on the ingest path, so tails are limited: at most 20 open per principal and 200
per org (`LOG_TAIL_MAX_PER_PRINCIPAL`, `LOG_TAIL_MAX_PER_ORG`); opening one more is a 429 `too_many_tails`. A stream
ends after 6 hours with `end` `{ code: 'max_lifetime' }`, and the Explorer and `yoal logs -f` reconnect silently
from their cursor, which runs authorisation again. A reconnect whose resume seq is zero, ahead of the newest row or
more than 50,000 rows behind resumes 2,000 rows before the newest instead of replaying the table.

---

## 5. Sources

| Source | Scope | Before | Built | Status |
|---|---|---|---|---|
| App runtime (process, container, compose, replicas) | project | `log_events` | adapter | built |
| Builds | project | `log_events` + `builds.log` (2 MB copy) | adapter; `builds.log` kept as the tail summary | built |
| Jobs and cron runs | project | `log_events.job_run_id` | adapter | built |
| Databases, storage, brokers | database / storage / broker | sibling tables | adapter | built |
| Kubernetes lifecycle and pod logs | k8s | `k8s_log_events`, `k8s_pod_logs` | adapter | built |
| Pipelines | pipeline (repository) | `pipeline_log_lines` (90 d fixed) | adapter; retention still fixed | built |
| Function runtime lines | function | `log_events` of function projects | adapter (read as `function` scopes) | built |
| Function tails | function project | ClickHouse JSON blobs | indexer explodes `logs_json` into records | **not built** |
| **Edge requests** | project (by host), else edge per node | 1-minute aggregates only | `access` records in `log_records`, IPs hashed (D248) | built |
| **OTLP logs from apps** | project | not built | agent loopback receiver, keyed path (D249) | built (JSON only) |
| **Yoal's own services** | platform (per node) | journald on the node, never shipped | drain the fixed units (D247) | built |
| Audit log | org | `audit_log` | read-only source in the Explorer, no copy | **not built** |
| Email events | org | SQLite + ClickHouse `email_events` | read-only source, no copy | **not built** |
| Console and cloud-shell sessions | — | memory only | out of scope (session recording is its own feature) | — |

**Edge requests (D248).** Caddy writes the JSON access log the agent tails for aggregates (it needs
`YOAL_CADDY_ACCESS_LOG`, which the installer sets). The agent also ships lines as `access` records. The body is
`GET /path 502 1234ms`, and the attributes are `http.method`, `http.route`, `http.status`, `duration_ms`, `bytes`,
`client.ip_hash` (the aggregator's hash), `user_agent.family`, `http.host` and `request_id`. Caddy sets
`X-Request-Id` upstream on site and unavailable routes, keeping an incoming one only from ingress `trustedProxies`
or the managed overlay and otherwise using `{http.request.uuid}`, and echoes it in the response, so app lines that
log the header join the request. Every non-2xx/3xx response is shipped, and 2xx/3xx at the route's
`accessLogSampleRate` (default 10%, deterministic per request id; set in log settings, D251). Records post per host
with the sampled-out count as `dropped`, and a host no project serves lands in the node's `edge` scope under the
sentinel org. Only a node that serves the host may post its lines: a node in the ingress set (every site), or a
worker holding the project's workload, spread copy or mid-move copy, or the project pinned to it, the same rule the
desired state uses for routes. Any other node gets a 403 and nothing is stored or counted. Aggregates are still
computed from 100% of lines, so traffic charts stay exact.

**OTLP logs (D249).** The agent listens on loopback (`127.0.0.1:8085`, the same listener as the `/tail` sink) for
OTLP/HTTP logs in JSON (gzip accepted). Protobuf is a 415 until spike S4. Process, container and compose apps get
`OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` pointing at `/otlp/<workload id>/<key>` (the
key is an HMAC of the workload id under the node-local `logs.key`), and `OTEL_SERVICE_NAME`, as DESIGN §8 promised;
an app's own values are never replaced. Only the keyed path accepts records: a bare `/v1/logs` is a 401, and traces
and metrics sent to the keyed path are answered 200 and discarded. The control plane resolves org, project and
deployment from the workload and never trusts resource attributes for tenancy. This fills the D16 receiver gap for
logs; metrics and traces can follow on the same listener.

**Platform logs (D247).** The helper reads journald for a fixed allow-list of units (`GET /v1/platform-logs/<unit>`):
`yoal-agent`, `yoal-helper`, `yoal-control-plane`, `yoal-control-plane-standby`, `yoal-builder`, `caddy`,
`yoal-mail`, `yoal-clickhouse`, `yoal-registry` and `yoal-litestream`. The agent polls every 5 s, keeps a cursor per
unit in its data dir, and posts to `/api/agent/log-records`. Each record is scoped `platform:<node id>` under the
sentinel org, with stream `unit:<name>`. Only platform admins see them, and each read is audited. Platform logs are
the first place to look when a 5xx appears in the agent journal, which used to mean SSH.

---

## 6. Query language

One grammar, called **log query** (D245). It is parsed to an AST in `@yoal/contracts/log-query`, autocompleted from
the same AST, and compiled on the server. A user never sends SQL, except platform admins in the SQL tab (D101 rule).

### 6.1 Filters

```
timeout                         body has the whole word "timeout" (token match; case-insensitive)
"connection reset"              phrase: case-insensitive substring (so is any word with punctuation)
level:error                     severity ≥ ERROR (level:warn means ≥ WARN; level:=warn means exactly WARN)
service:api  deployment:dep_…   built-in fields: level, body, service, scope, kind, project, deployment, build,
                                job, node, replica, source, stream, channel, pattern, trace, span, request
@http.status:>=500              attribute, with comparison operators > >= < <= on numbers
@user.id:123 @path:/api/*       wildcard
@msg:/time(out|d out)/          regex (ClickHouse only; marked in the UI)
@user.id:*                      the field exists
-@path:/health                  negation, also NOT
a OR b, (a b) c                 boolean logic with implicit AND
```

A bare word of letters and digits matches a whole token: body tokens are the runs between ASCII characters that are
not letters or digits, so `timeout` matches `upstream-Timeout:` but not `timeouts` or `UpstreamTimeout`. Anything
else, a quoted phrase or a word such as `user@example.com`, is a case-insensitive substring. The top comment of
`packages/contracts/src/log-query.ts` is the full semantic reference every engine follows.

**Regex limits.** Search runs regexes in ClickHouse (RE2, linear), but the same regex also runs in backtracking
JavaScript for live tail, rule previews and ingest rules, on the ingest path. So the parser accepts only a safe subset
(`checkRegexSafety` in `packages/contracts/src/log-regex.ts`, shared with redact rules): at most 512 characters; no
lookaround or backreferences; no `|` or quantifier inside a repeated or optional group (`(a+)+`, `(a|aa)*`,
`(\.\d+)?`); at most 2 unbounded repeats (`*`, `+`, `{n,}`); and a static worst-case cost check that refuses
neighbouring repeats that can overlap, such as `.*x.*y` or `\w+\w+` (a repeat followed by a required character it
cannot match, like `\d+ms` or `[^"]*"`, is fine). Common patterns such as `time(out|d out)`, `\d{3}ms`, `user=\w+`,
`^GET .* 500$` and `[a-f0-9]{8}` pass. JavaScript tests only the first 2 KiB of each value, while ClickHouse sees all
of it, so a match past 2 KiB shows in search but not in live tail or rules.

### 6.2 Pipe stages (ClickHouse)

```
| fields ts, level, @http.status, body          choose columns
| stats count() by bin(5m), level              aggregate: count, count_distinct, avg, p50/p90/p95/p99, min, max, sum
| stats p95(@duration_ms) by @http.route | sort p95 desc | limit 10
| patterns                                      group by template, with counts and sparklines
| dedup body                                    collapse repeats, with counts
| sort ts asc | limit 500
```

This deliberately follows CloudWatch Logs Insights' shape (`fields | filter | stats … by bin()`), so operators used
to AWS read it immediately. The filter syntax follows Datadog, Railway and Vercel so app developers do too.

### 6.3 Compilation

- **ClickHouse** (`log-store/clickhouse-compiler.ts`): AST → parameterised SQL over `yoal.logs`, with `org_id` and
  the boundary's scopes ANDed into every statement. Tokens use `hasToken`/`hasTokenCaseInsensitive`, substrings
  `positionCaseInsensitive`/`ILIKE`, regex `match()`. Run as `yoal_reader` with time, memory and row limits (D101).
- **SQLite, lite mode** (`log-store/sqlite-compiler.ts`): the same AST → a UNION ALL over the adapters whose scope
  kinds meet the boundary, supporting built-in fields, text (tokens emulated with a separator-rewritten `LIKE`),
  level bands, wildcards, time range, attributes on the sources that store them (`log_records`,
  `pipeline_log_lines`), and `| stats count() by bin()`, `| sort`, `| limit`. Anything else, regex included, returns
  a typed `needs_clickhouse` error (422) that the UI shows inline.
- **JS predicate** (`compileLogPredicate`): AST → `(r: LogRecord) => boolean` for live tail and rule preview (§10.3).

One corpus test asserts that the predicate, the SQLite compiler and the ClickHouse SQL agree, and runs live when a
ClickHouse server answers. Pipe stages and Why? need `logs:query` as well as `logs:read`.

### 6.4 Natural language

The assistant (L7) has a grammar summary in its system prompt whenever `query_logs` is offered
(`LOG_QUERY_GUIDE`). Asked for a query ("errors from api in the last hour after the 14:00 deploy"), it quotes the
request, gives the query in a code block and links it to the Explorer, CloudWatch Query Assist style. It never runs
a query it wrote for the user; it runs `query_logs` itself only to answer a question. The Explorer's **Ask AI**
actions (summarise errors in this window; explain this line or pattern) prefill the assistant panel.

---

## 7. The Explorer

One Svelte component, `LogExplorer` (`apps/control-plane/src/lib/logs/`, D253), built on the existing TanStack Query
and Virtual conventions. It mounts at `/logs` (a top-level nav entry for `logs:read`), where scope is open, and
locked to a scope with a preset query on project, function, deployment, build, database, storage, broker,
Kubernetes cluster and pod, and pipeline-job pages. Those pages lost their bespoke viewers.

### 7.1 Layout

```
┌ Scope: [org ▾] [project: api ▾] [+ deployment / node / source]   Time: [Last 1h ▾] [UTC|local]  [Live ●] ┐
│ Query: level:error -@path:/health "timeout" | stats count() by bin(1m)          [Run ⌘↵] [Save] [Share]  │
├──────────────┬───────────────────────────────────────────────────────────────────────────────────────┤
│ Fields       │ ▁▂▂▃█▇▃▂▁▁▂  histogram stacked by level · deploy markers ▼ · brush to zoom            │
│ level   ▮▮▯  │──────────────────────────────────────────────────────────────────────────────────────│
│ service ▮▯   │ Stream | Patterns (37) | Analytics | Compare                         [wrap] [cols ▾]  │
│ node    ▮▮▮  │ 14:02:11.204  ERR  api  r1  upstream timeout after 30000ms  @http.route=/v1/orders    │
│ @http.status │ 14:02:11.198  WRN  api  r0  retrying payment-svc (attempt 3)                          │
│ @http.route  │ ▸ 14:02:10.950 ERR  api  r1  TypeError: Cannot read properties of undefined (+14 lines)│
│ …            │ …  (virtualised; newest first; "↓ 214 new" while paused)                              │
└──────────────┴───────────────────────────────────────────────────────────────────────────────────────┘
```

### 7.2 Features

- **Scope tree** with counts: org → project or service → deployment or replica → stream. Platform scopes are shown
  to platform admins only.
- **Time picker**: relative (`15m`, `1h`, `24h`, `7d`), absolute, "around this time ±5 m", a UTC/local toggle, and
  brush-zoom on the histogram.
- **Histogram** stacked by level, with deploy markers (from `deployments`) and alert-fired markers. Node-event
  markers are not built.
- **Virtualised stream** in both directions: newest first, jump to time, infinite scroll in both directions by
  cursor.
- **Live tail** with pause on scroll or selection, an "N new" counter, resume, and a visible notice when sampled.
- **Facet sidebar** (ClickHouse): every built-in field and discovered attribute key, with its top values, a share
  bar and a sparkline. Click to filter, alt-click to exclude, as in Loki Drilldown. Facet visibility is per user and
  never changes a shared view (Datadog's rule).
- **Row expansion** with all fields, the raw line and a copy action; "filter to this value" from any field; and
  pivots (§9.3).
- **Context**: N lines before and after in the same stream, with the clicked line pinned and highlighted, like
  `grep -C`.
- **Rendering**: severity colouring from `severityNumber`, ANSI colours rendered (the ANSI is kept in a parsed
  side-channel instead of being stripped), a wrap toggle, JSON pretty-printed in the flyout, and highlighted search
  terms.
- **URL state**: query, scope, time, mode and selected row are all in the URL, so a link is a shareable
  investigation.
- **Saved queries**: personal or org, with name, query, scope, time and columns (`log_saved_queries`, the
  `logQuery` resource). They appear in the `⌘K` palette. The toolbar's **Create alert** and the Analytics tab's
  **Add to dashboard** turn the current query into an alert rule or a panel (§9).
- **Download**: NDJSON or CSV of the current query, capped at 100,000 rows (a larger export is a drain).

### 7.3 Keyboard

`/` focus query · `⌘↵` run · `j`/`k` move · `o` or `↵` expand · `c` context · `f` filter to the focused value ·
`x` exclude it · `space` pause or resume tail · `t` time picker · `[`/`]` previous or next time window ·
`⌘K` palette (saved queries and scopes) · `?` help · `esc` close. The keys are deliberately vim-adjacent,
like the HyperDX TUI.

---

## 8. Analysis

### 8.1 Patterns (D250)

The indexer runs an online Drain miner (`packages/core/src/log-patterns.ts`; fixed-depth parse tree, He et al. 2017)
per `(org, scope)`: depth 4, similarity 0.4, at most 100 children a node. It masks numbers, hex, UUIDs, IPs,
durations, timestamps, quoted strings, paths and emails (`<NUM> <HEX> <UUID> <IP> <DUR> <TS> <STR> <PATH> <EMAIL>`),
and stores `pattern_id` on each row: a stable FNV-1a 64-bit hex hash of the template, so ids agree across restarts.
Templates live in `yoal.log_patterns` with first and last seen. The miner is capped per scope (LRU at 5,000
templates). Its state is saved to `<dataDir>/log-patterns.json` every 10 minutes and on graceful shutdown and
restored at boot, instead of being rebuilt from the last hour. The Patterns tab is `| patterns`: the template with
masked placeholders highlighted, a count, a 24-bucket sparkline, and first-seen. Row actions are "only this pattern"
(`pattern:<id>`) and "hide this pattern" (`-pattern:<id>`), as in Better Stack. S3 measured 2.38 µs a line (§12).

### 8.2 Compare

Compare (`POST /api/v1/logs/compare`, `packages/core/src/log-analysis.ts`) runs the same query over two windows: the
previous period, the same window shifted back (yesterday, last week), a custom range, or **before and after a
deploy** (`deploy:<id>`, which reads the deployment's live time from SQLite). It classifies patterns by per-minute
rate as **new** (absent from the baseline), **gone**, **rising** (at least 2× and at least 5 lines), **falling**
(at most 0.5×) or steady, with counts per window. The URL form is
`mode=compare&baseline=previous|offset:<ms>|deploy:<id>|range:<from>-<to>`. It needs ClickHouse and `logs:query`. That is CloudWatch's Compare, made deploy-aware. "What did this deploy change in my logs?" is the
single most useful question a PaaS log tool can answer.

### 8.3 Why? (field differences)

Brush a region of the histogram and choose **Why?** (`POST /api/v1/logs/why`). The selection is compared against the
rest of the window across the built-in fields and the top 20 attribute keys, by value share, ranked by lift. The result is a ranked list such as
"`node = edge-b` is 92% of the selection vs 31% baseline", "`deployment = dep_x` 100% vs 0%" and
"`@http.route = /v1/orders` 88% vs 12%". This is Honeycomb BubbleUp's idea, implemented as count queries per
key on ClickHouse with the boundary ANDed into each. It needs ClickHouse and `logs:query`.

### 8.4 Analytics

`| stats` results render as a time series when grouped by `bin()`, otherwise as a table or bar chart, using the D101
panel renderers. "Add to dashboard" turns the query into a `logs` dataset panel (§9.2).

---

## 9. Acting on logs

### 9.1 Log alerts (D254, extends D109)

Two rule kinds sit on the existing alert-rule machinery and notifiers ([ALERTS.md](./ALERTS.md) §1, Log rules). A log rule's
query is a `logs` builder query (`query.builder.logs: { q, scopes }`), evaluated by the existing rule loop through
`LogExplorerService` as the org's `system:alerts` principal (`packages/core/src/log-alerts.ts`):

- **`log_count`**: the query's count over the window, `<filter> | stats count() [by …]`, crosses a threshold
  (`level:error service:api > 50 in 5m`). One series, or one per group-by field. ClickHouse when it answers, SQLite in
  lite mode.
- **`log_pattern_new`**: a pattern not seen in the scope during the lookback (default 7 days) appears at least N times
  in the window. With `afterDeployMinutes` it looks only while a deploy in scope went live within that many minutes,
  and the window starts at the deploy. This is noise-resistant in a way keyword alerts are not. It needs ClickHouse.

Templates: `log_errors` (more than 50 error lines in 5 minutes) and `log_new_pattern_after_deploy`. `alert_rules`
keeps the kind inside `spec_json`, so there is no migration. Notifications and alert instances carry an Explorer link
with the query, scopes and window filled in, and the Explorer toolbar has **Create alert**.

### 9.2 Log-based metrics and panels

- A **log metric** is a query plus `| stats` turned into a series. It is computed at query time through the Explorer
  (nothing is materialised). It appears in the dashboard builder as the **`logs` dataset** (measures `count` and
  `count_distinct` of a field; group by severity, source, scope, `bin` or any `@attribute`), so builder panels count
  log lines with the caller's boundary ANDed in.
- A **Logs panel** type in dashboards shows a scoped query's newest lines inline.

### 9.3 Pivots

| From | To |
|---|---|
| Log row with `request_id` | every line of that request across edge and app; the edge access record |
| Log row with `trace_id` | all lines in the trace (`trace:<id>`); an external trace UI link is not built |
| Log row | its deployment, build, node, replica, job run or pipeline step |
| Traffic chart 5xx spike | Explorer with `source:access @http.status:>=500` over the brushed window |
| App error event (APP-ERRORS) | lines from the same project ±60 s, the same `request_id` when present |
| Alert instance | the rule's query at fire time |
| Deployment page | "Logs for this deploy" and Compare against the time before it went live (`mode=compare&baseline=deploy:<id>`) |
| Node page | that node's platform logs (platform admins) |

---

## 10. Cost, retention and safety

### 10.1 Retention tiers (D251)

Settings live in `log_settings` (`packages/core/src/log-settings.ts`) with platform → org → project inheritance, and
are edited in **Settings → Logs** or `/api/v1/logs/settings`.

| Tier | Store | Default | Configurable |
|---|---|---|---|
| Hot tail | SQLite | 3 days with the search index, 7 without | 1–14 days, per org |
| Search | ClickHouse `yoal.logs` | 14 days | 1–90 days, per org, and per project |
| Archive | Parquet in the object store, hourly files per org per day | off | 30–400 days (90 when turned on) |

The hot tail is pruned by the maintenance sweep: rows past the org's hot days on every sweep, then each scope's rows
past 100,000 per table at most every 15 minutes. The cap pass only visits scopes whose `log_ingest_daily` lines over
the hot window exceed the cap, plus a full GROUP BY at most once a day for rows written without counting. Search retention is a daily lightweight `DELETE` per org (and per project with a shorter window); the
table's 90-day TTL is a backstop. The archive writes yesterday's `yoal.logs` rows as zstd Parquet, one file per hour
with rows (`logs-archive/<org>/<YYYY-MM-DD>/<HH>.parquet`), through the telemetry store's Parquet export, and
records each day in `log_archive_days` (migration 0143). **Rehydrate on query**: when a search reaches past the search
window, the answer carries an `archive` warning with an estimate (`POST /api/v1/logs/archive/estimate`: bytes, files,
seconds), and the archived part runs only when the request says `archive: true`. It is the same compiled search over
the files instead of `yoal.logs`, read with ClickHouse's `url()` table function over 15-minute presigned GET URLs
(not `s3()`, which would put the bucket's keys in `system.query_log`), with a 20 GiB scan budget; an estimate over
the budget is refused. The rehydrate query runs as the writer user, because `url()` needs a grant that `yoal_reader`
must not have: the reader runs the platform SQL tab (D101), and a URL grant there would let that SQL fetch any
address the ClickHouse host reaches. Each rehydrate query instead carries `readonly = 2` (reads only;
`readonly = 1` also forbids table functions) and explicit `max_execution_time`, `max_bytes_to_read`,
`max_memory_usage` (256 MiB), `max_threads` and `max_result_rows` caps. Platform logs follow the platform row.

### 10.2 Quotas (QUOTAS.md)

Per project (or service scope) there is an ingest rate, **1,000 lines/s with a 20,000-line burst**, and a daily
budget of **5,120 MB**, and per scope a 100,000-row cap per table in the hot tail. These replace the global
500,000-row cap. An org or project may only lower the platform values. The rate is an in-memory token bucket; the
daily total is seeded from `log_ingest_daily` so a restart does not reset it. Over-quota lines are dropped at ingest
and counted in `log_drop_counts`, and one `system` record per minute per scope says how many lines were dropped and
why. Edge `access` lines have their own bucket and daily total per scope (`access:<kind>:<id>`) with the same
limits, because outsiders choose how many 4xx lines a site logs: a flood cannot spend the project's runtime-log
quota. Showback stays one row per scope. **Settings → Usage** shows log GB/day per project, for showback (`/api/v1/logs/usage`).
`YOAL_FEATURE_QUOTAS=0` stops enforcement; counting continues.

### 10.3 Exclusion and sampling

An org or project rule (`log_rules`, `/api/v1/logs/rules`) is a log query plus an action: **exclude**, **sample**
(keep N%), or **index only**, which keeps the line in the hot tail and drains but not in ClickHouse; or a
**redact** regex (§10.4). Exclude and sample apply at ingest, so drains honour them too; index only applies at the
indexer. Before saving, the UI **previews** the rule by replaying the last 15 minutes of the hot tail through the
predicate: "would drop 41% of lines, mostly pattern 'GET /health 200'". Datadog has exclusion filters but no
preview.

### 10.4 Redaction (D252)

Redaction runs at ingest, before SQLite, drains and the indexer, on every append path (`LogIngestGuard` in
`packages/core/src/log-ingest-guard.ts`, `createRedactor` in `log-redaction.ts`):

- **Known secret values**: the org's secret env values with their base64, URL-encoded and per-line forms (the
  pipeline masker's set, D152), held only as fingerprints: a keyed rolling hash of the first 8 characters as the
  prefilter and a keyed HMAC-SHA256 of the whole value as the confirmation, under a key derived from the master key
  with HKDF. The set is rebuilt when a secret changes, never per line, and nothing is decrypted on the hot path.
- Built-in detectors: private key blocks, JWTs, AWS, GCP, GitHub, GitLab, Slack and Stripe tokens, Yoal's own
  credentials (`yoal_`, `yoal_svc_`, `yoalp_`, `scim_`, node tokens by context, `SKF`/`SKR` storage key ids), URLs
  with `user:password@`, `Authorization`/`Cookie`/`Set-Cookie` values, `Bearer` credentials, credential-named keys
  (`password=`, `token=`, `api_key=`…), and long high-entropy strings in `key=` positions. UUIDs, git SHAs and
  content hashes pass through.
- Org `redact` rules (regex), with the rule preview. A rule must be in the same safe regex subset as queries
  (§6.1), and is applied to the first 2 KiB of a line; the known-secret matcher and the built-in detectors cover
  the whole line.

Each match becomes `[REDACTED:<kind>]`. S5 measured 1.25 µs a line at p50 with 50 secrets (§12). The
credential-key detector bounds its key prefix to 64 characters, so an adversarial 16 KiB line (`a_a_a…token`) costs
about 1.5 ms rather than 180 ms.

### 10.5 Access

| Permission | Covers |
|---|---|
| `logs:read` | records in the scopes the principal can read. Bindable at org, project and environment, and now also at database, storage, broker, Kubernetes cluster and pipeline repository scope; function projects read as `function` scopes |
| `logs:query` | pipe stages, Compare and Why? (cost control for API keys); granted with `logs:read` to deployer and viewer, and held by owner and admin |
| `logs:configure` | retention, quotas, the archive, edge sampling and ingest rules (§10); owner and admin |
| `logQuery:create/read/update/delete/manage` | saved queries; `manage` edits or deletes other people's org queries (owner and admin) |
| platform admin | `platform` and `edge` scopes for the whole install, and the platform settings row |

`LogExplorerService` resolves a read boundary from the principal and intersects requested scopes with it; a scope
the caller cannot read is dropped silently, so naming another org's scope returns nothing and never confirms it
exists. Reads of platform and edge records are written to the audit log as `logs.read_platform`. Tenant reads are not
audited (too noisy), but MCP reads already are, as `mcp.<tool>`. The Explorer has no SQL tab; platform admins keep
the D101 SQL path in dashboards.

---

## 11. Phases

| Phase | Delivers | Exit criteria |
|---|---|---|
| **L0** Spikes | S1–S5 (§12) | numbers recorded in this doc; D244 and D250 confirmed or changed |
| **L1** One model, one viewer | `LogRecord` + `log-query` grammar (parser, AST, JS predicate, SQLite compiler) in contracts; `LogStore` seam with a SQLite adapter over every existing table; `GET /api/v1/logs` (scope, time range, query, cursor) + `/api/v1/logs/stream` (SSE over the in-process bus); `LogExplorer` replaces `LogsPanel`, `ServiceLogs`, `PodLogs`, `JobLogs`; `/logs` nav entry; per-scope caps replace the global cap; `yoal logs [scope] -q --since --until -f --json`; MCP `query_logs` | every existing viewer's feature set is preserved (step grouping for pipelines); tail no longer polls SQLite; e2e on mac-dev and linux-box |
| **L2** Search index | `yoal.logs` + indexer cursors; multiline at the agent; JSON/logfmt parse, severity, ids; facets, autocomplete from field stats; context; saved queries; histogram markers; lite-mode messaging | 24 h project query < 1 s and histogram < 1.5 s at 10 M rows under a 768 MiB cap; ClickHouse outage → tail unaffected, index catches up |
| **L3** Every source | platform units (admin); edge request records + `X-Request-Id`; agent OTLP/HTTP logs receiver; function tails exploded; audit and email as read-only sources; `log_records` table | a request is traceable edge → app in one click; platform 5xx investigation without SSH |
| **L4** Analysis | Drain patterns; `\| stats`, `\| patterns`, `\| dedup`; Analytics tab; Compare (including deploy-aware); Why? | "what changed after deploy X" answered with no typing |
| **L5** Act | `log_count` and `log_pattern_new` alert rules; `logs` dashboard dataset and Logs panel; pivots from traffic, app errors, alerts and deploys | an alert link opens the exact window and query |
| **L6** Cost and safety | retention tiers + Parquet archive + rehydrate with estimate; quotas + drop counters; exclusion and sampling with preview; redaction rules; platform read audit | a noisy project cannot evict another's logs; secrets in a test app never reach storage |
| **L7** Assistant and agents | NL → query; "explain this pattern" and "summarise errors in this window"; MCP `get_log_patterns`, `get_log_context`, `compare_logs`; the per-resource MCP log tools become thin wrappers | the assistant answers "why did api 500 at 14:02" with linked evidence |

L1 is useful on its own and does not need ClickHouse. The kill switches are `LOG_INDEX`, `PLATFORM_LOGS`,
`EDGE_REQUEST_LOGS` and `OTLP_LOGS` ([OPS.md](./OPS.md) §2.5).

### 11.1 Implementation status (2026-11-26)

| Phase | Built | Not built |
|---|---|---|
| **L0** Spikes | S1 (5 M rows), S3, S5 (§12) | S2 (SQLite and Litestream load) and S4 (OTLP protobuf decode) were not run; S1 at 10–50 M rows |
| **L1** One model, one viewer | `LogRecord`, the grammar, parser, formatter, predicate and suggestions (D243, D245); `SqliteLogStore` over every table; `/api/v1/logs/*` and the SSE tail over the in-process bus (D246); `LogExplorer` everywhere and `/logs` (D253); per-scope caps; `yoal logs` with `-f`; MCP `query_logs` | e2e on mac-dev and linux-box |
| **L2** Search index | `yoal.logs`, `yoal.log_patterns`, the cursor indexer (D244); multiline join in the agent; JSON/logfmt parse, severity and ids; facets with sparklines; autocomplete; context; saved queries; deploy and alert markers; lite-mode banner and `needs_clickhouse` | the "no timestamp within 50 ms" multiline rule; node-event markers; promoting hot attribute keys to typed columns |
| **L3** Every source | platform units (D247); edge `X-Request-Id` and access records (D248); the OTLP/HTTP JSON logs receiver and `OTEL_*` injection (D249); `log_records` | OTLP protobuf (415); function tails exploded into records; audit log and email events as read-only sources; folding the sibling tables into `log_records`; drains of `log_records`, pipeline and Kubernetes lines (drains still read only `log_events`, `service_log_events` and `broker_log_events`, D141) |
| **L4** Analysis | Drain patterns at index time with a snapshot file (D250); `\| stats`, `\| patterns` (first seen, sparklines), `\| dedup`; Patterns, Analytics and Compare tabs; deploy-aware Compare; Why? | — |
| **L5** Act | `log_count` and `log_pattern_new` rules with templates (D254); `logs` dashboard dataset and Logs panel; pivots from traffic 5xx, app errors, alert instances, deployments and nodes | an external trace UI link |
| **L6** Cost and safety | settings with inheritance; hot, search and archive tiers with rehydrate and estimate; quotas, drop counters and notices; exclude, sample, index-only and redact rules with preview; redaction at ingest; platform read audit (D251, D252) | "Purge lines matching…" across both stores; moving pipeline and Kubernetes retention under the settings |
| **L7** Assistant and agents | the grammar summary in the assistant prompt; Ask AI (summarise errors, explain a line or pattern); MCP `query_logs`, `get_log_patterns`, `get_log_context`, `compare_logs`, `explain_log_spike`; `get_logs`, `get_database_logs`, `get_storage_logs` and `get_broker_logs` as thin wrappers; `yoal logs patterns`, `context` and `compare` | the Explorer's SQL tab (platform admins use dashboards SQL) |

Migrations: 0142 (`log_records`, `log_index_cursors`, `log_saved_queries`, `log_rules`, `log_settings`,
`log_drop_counts`) and 0143 (`log_ingest_daily`, `log_archive_days`).

---

## 12. Spikes

| ID | Question | Pass criteria | Result |
|---|---|---|---|
| S1 | Does ClickHouse 26.8's `text` index (GA 2026-03) work under the 768 MiB default cap with 10–50 M rows of realistic logs? `Map` vs `JSON` for attributes; `tokenbf_v1` fallback | token search on a 24 h project scope < 1 s; merges stay under the cap; on-disk bytes per line recorded | **Pass** at a 5 M-row scope (not 10–50 M): token search 17 ms, histogram 55–78 ms, 62.1 bytes a row on disk, peak RSS 747 MiB at the 768 MiB cap. Facets took 1.78 s, so the facet query needs sampling. `Map` kept. |
| S2 | SQLite and Litestream cost at sustained 500 and 2,000 lines/s through `/api/agent/logs` | p99 state-write latency unchanged within 10%; otherwise move log tables to an unstreamed `logs.db` | **Not run.** The log tables stay in the state database (§4.1). |
| S3 | Drain miner cost in Bun (TS) per line, and memory per 5,000 templates | < 20 µs per line p50; < 50 MB per 100 scopes | **Pass**: 2.38 µs a line at p50 (`spikes/logs-bench/s3-patterns.ts`); about 13 MB for 100 scopes. |
| S4 | OTLP/HTTP protobuf decode in Bun without a native addon (`protobufjs` or a generated decoder) | 10 k records/s per core; JSON path shipped first regardless | **Not run.** JSON shipped; protobuf is a 415. |
| S5 | Known-secret redaction without decrypting on the hot path | design that matches every secret value ≥ 8 chars with < 5 µs per line overhead | **Pass**: 1.25 µs a line at p50 for the full redactor with 50 secrets; the secret matcher adds about 0.3 µs at 50 or 500 (`spikes/logs-bench/s5-redaction.ts`). |

---

## 13. Decisions

The proposals were built and recorded as D243–D254 in [DECISIONS.md](./DECISIONS.md), which states each one as built.
The old LP numbers are kept here because code comments cite them.

| ID | Decision |
|---|---|
| D243 (LP1) | **One OTel-shaped `LogRecord` for every source**, with Yoal scope `{kind, id}`, stream, severity number, attributes, resource, and trace and request IDs, in epoch ms. Existing tables map through adapters; new sources write `log_records`; platform rows use the sentinel org `'platform'`. |
| D244 (LP2) | **SQLite stays the write path and hot tail; ClickHouse `yoal.logs` is a derived search index** fed by an idempotent cursor indexer. Logs never depend on ClickHouse being up. (Replaced FEATURE-RESEARCH's "log warehouse: do not build" row.) |
| D245 (LP3) | **One log-query grammar** (filters + Insights-style pipe stages) in `@yoal/contracts`, compiled on the server with tenancy ANDed in. A bare alphanumeric word is a whole-token match, anything else a substring. Raw SQL is for platform admins only (as in D101). |
| D246 (LP4) | **Live tail is an in-process bus with per-subscriber compiled predicates**, resumable by seq vector. No polling. |
| D247 (LP5) | **Yoal's own service logs are the `platform` scope**, drained from a fixed unit allow-list. Platform admins only, and reads are audited. |
| D248 (LP6) | **The edge injects `X-Request-Id` and ships access records**: all non-2xx plus a 2xx sample. Aggregates still use 100% of lines. |
| D249 (LP7) | **The agent runs an OTLP/HTTP logs receiver on loopback**, on a keyed path only. Workloads get `OTEL_EXPORTER_OTLP_ENDPOINT`, and the control plane resolves tenancy from the workload. |
| D250 (LP8) | **Patterns are mined at index time** (Drain) and stored as `pattern_id`, so patterns, compare and `log_pattern_new` alerts are plain GROUP BYs. |
| D251 (LP9) | **Retention is three tiers per org and project** (hot tail 3/7 days, search 14, archive off; rehydrate through `url()` over presigned GETs), and **quotas are per project** (1,000 lines/s, 20,000 burst, 5,120 MB/day), replacing the global row cap. Edge sampling defaults to 0.1. |
| D252 (LP10) | **Redaction runs at ingest**, before storage, drains and the index: built-in detectors, known secret values and org rules. |
| D253 (LP11) | **One `LogExplorer` component everywhere**, with all state in the URL. Bespoke log viewers are removed. |
| D254 (LP12) | **Log alerts are alert-rule kinds** (`log_count`, `log_pattern_new`) on the D109 machinery and notifiers. |

---

## 14. Alternatives considered

| Alternative | Why not (now) |
|---|---|
| **VictoriaLogs** as a dedicated log store | Best single-binary footprint and LogsQL is good. But it would be a second telemetry server to install, update, back up and secure next to ClickHouse. It has no native object-storage tier and no replication between storage nodes, and tenancy is header-based with no authorisation, so our proxy would be the boundary either way. The `LogStore` seam keeps it open as an adapter if S1 fails. |
| **Grafana Loki** | Rejected by D15 (bundled stack). The label-cardinality model fights structured field filters. Loki 4.0 removed simple-scalable mode. |
| **OpenObserve, Parseable** | AGPL; a second UI and auth model. |
| **Quickwit** | Object-storage native and Apache-2.0, but Datadog-owned since 2025 with an uncertain cadence, and multi-service. |
| **SQLite FTS5 only** | No aggregation at scale. Write amplification in the Litestream-streamed state DB. Fine as a lite-mode upgrade later. |
| **Postgres (pg_search, Timescale)** | Postgres is a managed tenant service here, not platform state; AGPL or Timescale licence questions. |
| **Fluent Bit, Vector or OTel Collector on nodes** | D141 and D16 chose agent shipping, and the journald-through-helper path works. Revisit only if S2 shows the agent drain is the bottleneck, in which case Fluent Bit would ship to the same `/api/agent/logs` contract. |
| **Index on the write path** (append straight to ClickHouse) | It couples ingest to an optional service and loses lines during ClickHouse restarts. The cursor indexer gets the same result with replay. |

---

## 15. Risks and open questions

**Risks**

- **Two capability tiers.** Lite mode versus ClickHouse mode doubles the test matrix. Mitigation: one AST with typed
  `needs_clickhouse` errors, and contract tests that run the same query suite against both compilers.
- **ClickHouse memory.** Merges on wide `Map` columns under 768 MiB (S1). Mitigation: promote hot keys, and lower
  `max_bytes_to_merge_at_max_space_in_pool` if needed. Settings → Telemetry already lets the owner raise the cap.
- **State DB load** from log volume (S2, not yet run). Mitigation: a `logs.db` split.
- **Redaction misses.** No detector is complete. Document it as defence in depth, never as a guarantee, and keep
  "Purge lines matching…" as an admin action across both stores.
- **Cross-tenant leakage through new query features.** Every compiler path takes the server-resolved boundary.
  Tests assert that a query naming another org's scope returns nothing and does not error in a way that leaks
  existence, and that only platform admins see sentinel-org records.

**Decided (Kieran, 2026-11-25)**

1. **ClickHouse stays optional.** Without it the Explorer runs in lite mode over SQLite, and `/logs` shows a banner
   linking to Settings → Telemetry. No install is nudged by node count.
2. **Platform logs are for platform admins only** (D247). Org owners do not see them, even for nodes that run only
   their org's workloads.
3. **Edge 2xx sampling defaults to 10%** (D248). Every non-2xx response is always shipped, and 100% per site is a
   toggle.
4. **The archive tier is off by default** (D251). An owner opts in.
5. **Adapters first.** The Explorer reads the sibling tables through adapters. Folding them into `log_records`
   waits until the adapters have run in production; it is not done.

---

## Appendix: research

What other products contribute, and what the design takes from each:

| Product | Idea taken | Where |
|---|---|---|
| CloudWatch Logs | groups and streams → scope and stream; Insights `fields \| stats … by bin()`; Live Tail with sampling notice; pattern Compare across windows; Query Assist (NL → editable query, prompt kept as a comment) | §3, §6.2, §4.4, §8.2, §6.4 |
| Grafana Loki / Logs Drilldown | per-field volume breakdowns; patterns from recent ingest; `grep -C` context; dedup modes; filters before parsers | §7.2, §8.1, §6.2 |
| Datadog Log Explorer | facets (per-user visibility); saved views; exclusion and sampling filters separated from ingest; rehydration from archive with a scan cap | §7.2, §10.3, §10.1 |
| Honeycomb BubbleUp | compare a selection with its baseline across all fields | §8.3 |
| Better Stack | "filter or exclude by pattern" row actions; live-tail presets | §8.1, §7.2 |
| Railway, Vercel, Papertrail | `@attr:value`, `-` negation, request-ID paste becomes a filter, pause/live tail | §6.1, §7.2 |
| HyperDX / ClickStack | the ClickHouse OTel log schema; Lucene-ish search and SQL side by side; a keyboard-first TUI | §4.2, §6, §7.3 |
| Kibana Discover | surrounding documents keep the filters; field → visualise | §7.2, §8.4 |
| OpenTelemetry | the logs data model, SeverityNumber bands, resource semantic conventions | §3 |
| Drain (He et al., ICWS 2017) | online fixed-depth template mining | §8.1 |

Sources:

- [CloudWatch Compare](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_AnalyzeLogData_Compare.html)
- [CloudWatch pattern analysis](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_AnalyzeLogData_Patterns.html)
- [CloudWatch Query Assist](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CloudWatchLogs-Insights-Query-Assist.html)
- [Grafana Logs Drilldown: labels and fields](https://grafana.com/docs/grafana/latest/visualizations/simplified-exploration/logs/labels-and-fields/)
- [Grafana Logs Drilldown: patterns](https://grafana.com/docs/grafana/next/visualizations/simplified-exploration/logs/patterns/)
- [LogQL log queries](https://grafana.com/docs/loki/latest/query/log_queries/)
- [Datadog facets](https://docs.datadoghq.com/logs/explorer/facets/)
- [Datadog: Logging without Limits](https://www.datadoghq.com/blog/logging-without-limits/)
- [Honeycomb BubbleUp](https://docs.honeycomb.io/working-with-your-data/bubbleup/)
- [Better Stack live tail query language](https://betterstack.com/docs/logs/using-logtail/live-tail-query-language)
- [Railway logs](https://docs.railway.com/observability/logs)
- [Vercel runtime logs](https://vercel.com/docs/logs/runtime)
- [Papertrail search syntax](https://www.papertrail.com/help/search-syntax/)
- [ClickStack](https://clickhouse.com/docs/clickstack/overview)
- [ClickHouse full-text search GA](https://clickhouse.com/blog/full-text-search-ga-release)
- [VictoriaLogs](https://docs.victoriametrics.com/victorialogs/)
- [VictoriaLogs cluster](https://docs.victoriametrics.com/victorialogs/cluster/)
- [Loki 4.0 SSD removal](https://grafana.com/whats-next/2026-08-24-loki-ssd-deployment-no-longer-available/)
- [Log collector benchmark 2026](https://victoriametrics.com/blog/log-collectors-benchmark-2026/)
- [OTel logs data model](https://opentelemetry.io/docs/specs/otel/logs/data-model/)
- [Drain paper](https://pinjiahe.github.io/files/pdf/research/ICWS17.pdf)
- [Drain3](https://github.com/IBM/Drain3)

Most vendor details above came from documentation search results rather than full reads. Before a decision relies
on a vendor behaviour (rather than only borrowing the idea), check it at its source. The ClickHouse text-index facts
were re-verified in S1.
