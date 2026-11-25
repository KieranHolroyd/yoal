# Yoal — Logs Explorer

Status: **plan, 2026-11-25.** Nothing here is built. The mechanisms are **proposals (LP1–LP12)**. Each one
becomes a D-number when its spike (§12) passes and it is built. The phases are **L0–L7** (§11). Sections describe the
target design in the present tense. "Today" means verified in the tree on 2026-11-25. Kieran settled the open
questions on 2026-11-25 (§15), so the plan is agreed and L0/L1 can start.

Related: [DESIGN.md](./DESIGN.md) §8 (observability), D15, D16, D101 (ClickHouse telemetry), D109 (alert rules),
D141 (log drains), D153 (pipeline logs), [APP-ERRORS.md](./APP-ERRORS.md), [SERVER-ERRORS.md](./SERVER-ERRORS.md),
[ALERTS.md](./ALERTS.md), [QUOTAS.md](./QUOTAS.md), [IAM.md](./IAM.md), [ASSISTANT.md](./ASSISTANT.md).

**Contents:** [0 Summary](#0-summary) · [1 Today](#1-today) · [2 Goals](#2-goals-and-non-goals) ·
[3 Record model](#3-one-record-model) · [4 Pipeline](#4-ingest-pipeline-and-stores) · [5 Sources](#5-sources) ·
[6 Query language](#6-query-language) · [7 Explorer UI](#7-the-explorer) · [8 Analysis](#8-analysis) ·
[9 Act on logs](#9-acting-on-logs) · [10 Cost and safety](#10-cost-retention-and-safety) · [11 Phases](#11-phases) ·
[12 Spikes](#12-spikes) · [13 Proposals](#13-proposals) · [14 Alternatives](#14-alternatives-considered) ·
[15 Risks and open questions](#15-risks-and-open-questions) · [Appendix: research](#appendix-research)

---

## 0. Summary

Every log line produced anywhere on the platform, from apps, builds, jobs, pipelines, databases, brokers, storage,
Kubernetes, functions, the edge and Yoal's own services, becomes one **LogRecord**. There is one **Explorer** to
search it, at `/logs` for a whole org and embedded, pre-scoped, on every resource page. It combines CloudWatch's
groups, Insights queries, Live Tail and pattern compare with Loki Drilldown's per-field volume breakdowns,
Datadog's facets and saved views, and Honeycomb's "what's different about this spike".

Five ideas carry the plan:

1. **One record model, shaped like OpenTelemetry** (§3). Scope, severity number, body, attributes, resource, and
   trace and request IDs.
2. **SQLite stays the hot tail; ClickHouse becomes the search index** (§4). Ingest still writes SQLite, as it does
   today, so live tail and drains (D141) keep working without ClickHouse. A cursor **indexer** copies, parses,
   pattern-mines and redacts rows into a ClickHouse `logs` table. This is the same at-least-once cursor machinery
   drains use, so a ClickHouse outage only delays search. It never loses lines.
3. **One query language, compiled on the server** (§6). Datadog/Railway-style filters (`level:error service:api
   -path:/health "timeout"`) plus Insights-style pipe stages (`| stats count() by bin(5m), level`, `| patterns`).
   The grammar lives in `@yoal/contracts`, so the dashboard, CLI, MCP and assistant share one parser. Tenancy is
   ANDed in on the server, exactly like the D101 dashboard builder.
4. **One Explorer component** (§7) replaces the four viewers that exist today (`LogsPanel`, `ServiceLogs`, `PodLogs`,
   `JobLogs`). It has a time histogram you can brush to zoom, a facet sidebar, live tail, row context, and Stream,
   Patterns, Analytics and Compare modes.
5. **Logs you can act on** (§9). Saved queries become alert rules (a count threshold, or "a new pattern appeared
   after a deploy"), dashboard panels and log-based metrics, and every row pivots to its deploy, request, app error
   and node.

Without ClickHouse, the Explorer still runs, in a smaller "lite" mode over SQLite: scope, time range, built-in
filters, histogram, live tail and context. Facets on parsed fields, patterns, stats and compare need ClickHouse, and
the UI says so with a link to Settings → Telemetry. This keeps D101's "optional and fail-open" promise.

---

## 1. Today

What is in the tree (verified 2026-11-25):

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

[FEATURE-RESEARCH.md](./FEATURE-RESEARCH.md) lists "log warehouse" under *Do not build* in favour of export. This
plan replaces that row once it is adopted (§13). Drains and OTLP export stay, but an operator should not need a
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

- Distributed trace storage and a span waterfall. The plan carries `trace_id` and `span_id` so a trace store can join
  later, and so external trace tools can be linked.
- A general SIEM, including correlation rules across orgs.
- Replacing drains. Drains remain the way to send logs elsewhere (D141).
- A second log engine (Loki, VictoriaLogs and others; §14). ClickHouse is already the telemetry store.

---

## 3. One record model

`LogRecord` lives in `@yoal/contracts` and follows the OpenTelemetry logs data model, with Yoal's scope added.

| Field | Notes |
|---|---|
| `id` | Stable: `<table>:<seq>` today, and a ULID for new sources. Drains already promise a stable `id`. |
| `ts`, `observedTs` | Event time (parsed from the line when present, otherwise `observedTs`) and receive time, in ns. |
| `orgId` | Always set by the server. |
| `scope` | `{ kind, id }` where `kind` is `project · database · storage · broker · k8s · pipeline · function · edge · platform`. This plays the role of CloudWatch's log group. |
| `stream` | A finer stream inside the scope: deployment + replica, build, job run, pipeline job + step, pod, node service. This plays the role of a CloudWatch log stream. |
| `source` | `runtime · build · job · pipeline · system · access · otlp · audit · platform` |
| `severityNumber`, `severityText` | OTel 1–24. The current `debug/info/warn/error` levels map to 5/9/13/17, and `fatal` is added (21). |
| `body` | The message text, still capped at 16 KB. Structured OTLP bodies are stored as JSON text. |
| `attributes` | Per-record fields: parsed JSON or logfmt keys, `http.*`, and user keys from OTLP. |
| `resource` | `service.name` (project slug or service name), `deployment.id`, `host.name` (node), `container.id`, `k8s.*` |
| `traceId`, `spanId`, `requestId` | Extracted at index time (§4.3). |
| `patternId` | Drain template hash (§8.1). |

The existing tables are not rewritten in L1. An adapter maps each one onto `LogRecord`, and new sources write a new
generic SQLite table, `log_records`. It has no CHECKs on `kind` or `source`, which is the lesson of 0028. Once L3
ships, the siblings can be folded into it by a later migration.

---

## 4. Ingest pipeline and stores

```
 node: journald / builder / step runner / OTLP / Caddy access file
        │  (agent drain, unchanged transport: POST /api/agent/logs)
        ▼
 control plane: LogService.append*  ── redaction (LP10) ── quota check (LP9)
        │                         └──► in-memory tail bus ──► SSE / CLI -f / MCP tail
        ▼
 SQLite hot tail (log_events, …, log_records)  ── cursor ──► drains (D141, unchanged)
        │
        └── cursor ──► indexer: parse · severity · ids · multiline · patterns ──► ClickHouse yoal.logs
                                                                          └──► daily Parquet archive (LP9)
```

### 4.1 SQLite is the hot tail (LP2)

The write path stays where it is. SQLite holds a short window: the default is 3 days when ClickHouse is installed,
and the current 7 days without it. It serves live tail, context lookups and drains, and is what lite mode searches.
The global 500,000-row cap becomes a **per-scope cap** (LP9).

**Concern.** Log rows sit in the platform state database, which Litestream streams. At high volume that streaming
replicates disposable data and competes with state writes. Spike S2 measures this. If it is a problem, the log
tables move to an attached `logs.db` that Litestream does not stream. The rows are already disposable: drains and
the indexer have read them.

### 4.2 The indexer feeds ClickHouse (LP2)

The indexer is a control-plane loop built like the drain worker (`packages/core/src/log-drains.ts`). It keeps one
cursor per source table in SQLite, reads batches of up to 5,000 rows, enriches them, and inserts into `yoal.logs`
with an `insert_deduplication_token` derived from the cursor range, so a replay after a crash is idempotent. It
moves the cursor only after ClickHouse acknowledges. It is fail-open: a ClickHouse outage stalls the cursor and the
Explorer shows "search index N minutes behind". Live tail is unaffected.

`yoal.logs` (sketch; S1 confirms the index types on 26.8):

```sql
CREATE TABLE yoal.logs (
  ts DateTime64(9), observed_ts DateTime64(3), id String,
  org_id LowCardinality(String), scope_kind LowCardinality(String), scope_id String,
  stream_id String, project_id String, deployment_id String, node_id LowCardinality(String),
  source LowCardinality(String), severity_number UInt8, severity_text LowCardinality(String),
  body String, pattern_id UInt64,
  trace_id String, span_id String, request_id String,
  attributes Map(LowCardinality(String), String),
  resource Map(LowCardinality(String), String),
  INDEX body_text body TYPE text(tokenizer = 'splitByNonAlpha') GRANULARITY 1,   -- fallback: tokenbf_v1
  INDEX req request_id TYPE bloom_filter GRANULARITY 4,
  INDEX trace trace_id TYPE bloom_filter GRANULARITY 4,
  INDEX attr_keys mapKeys(attributes) TYPE bloom_filter GRANULARITY 4
) ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (org_id, scope_kind, scope_id, ts)
TTL toDateTime(ts) + INTERVAL 14 DAY      -- backstop; per-scope prune is explicit (LP9)
```

Hot attribute keys (`http.status`, `http.path`, `duration_ms`) may be promoted to typed materialized columns once S1
shows they are worth it. Spike S1 also decides `Map` versus ClickHouse's `JSON` type.

### 4.3 Enrichment, in index order

1. **Multiline join.** Continuation lines are joined to the previous record from the same stream and replica:
   indented lines, `at …` / `Caused by:` / `Traceback`, and lines that start without a timestamp within 50 ms. This
   happens in the agent's drain, before shipping, because only it sees the exact unit order. That is a small change
   to `apps/agent/src/log-drain.ts` with a 1 s flush cap.
2. **Parse.** A body that is a JSON object, or logfmt with at least two `k=v` pairs, becomes attributes. The body
   becomes `msg`, `message` or `event` if one exists, and otherwise stays the original text. `parseLogLine` already
   recovers level and timestamp, and this extends it.
3. **Severity.** Take the parsed `level`, `severity` or `lvl`, then the existing heuristic, then the stream
   (stderr → warn only when nothing else applies), and map to an OTel number.
4. **IDs.** `trace_id` comes from `traceparent`, `trace_id`, `traceId` or `dd.trace_id`. `request_id` comes from
   `request_id`, `requestId`, `req_id`, or the `X-Request-Id` value Yoal injects at the edge (LP6).
5. **Redaction** has already run at ingest (LP10), so the indexer never sees secrets.
6. **Pattern.** A Drain template ID (§8.1).

### 4.4 Live tail (LP4)

`LogService.append*` publishes the rows it inserts to an in-process bus. Each SSE, CLI `-f` or MCP tail subscriber
compiles its query once to a JavaScript predicate (§6.3) and receives only matching rows. No subscriber polls the
database any more. Reconnects resume by `Last-Event-ID`, a per-table seq vector, using a SQLite catch-up read and
then the bus. A subscriber that falls more than 2,000 lines behind gets a "sampled" marker and the newest lines,
like CloudWatch Live Tail. The bus is per control-plane process, which is correct with one active control plane.
The standby (CLUSTERING §6) starts with an empty bus and clients reconnect.

---

## 5. Sources

| Source | Scope | Today | Plan | Phase |
|---|---|---|---|---|
| App runtime (process, container, compose, replicas) | project | `log_events` | adapter, then `log_records` | L1 |
| Builds | project | `log_events` + `builds.log` (2 MB copy) | adapter; `builds.log` kept as the tail summary only | L1 |
| Jobs and cron runs | project | `log_events.job_run_id` | adapter | L1 |
| Databases, storage, brokers | database / storage / broker | sibling tables | adapter | L1 |
| Kubernetes lifecycle and pod logs | k8s | `k8s_log_events`, `k8s_pod_logs` | adapter | L1 |
| Pipelines | pipeline (repository) | `pipeline_log_lines` (90 d fixed) | adapter; retention moves under LP9 | L1 |
| Function tails | function project | ClickHouse JSON blobs | indexer explodes `logs_json` into records | L3 |
| **Edge requests** | edge (per site/project) | 1-minute aggregates only | raw access lines, IPs hashed as today | L3 |
| **OTLP logs from apps** | project | not built | agent loopback receiver | L3 |
| **Yoal's own services** | platform (per node) | journald on the node, never shipped | drain the fixed units | L3 |
| Audit log | org | `audit_log` | read-only source in the Explorer, no copy | L3 |
| Email events | org | SQLite + ClickHouse `email_events` | read-only source, no copy | L3 |
| Console and cloud-shell sessions | — | memory only | out of scope (session recording is its own feature) | — |

**Edge requests (LP6).** Caddy already writes the JSON access log the agent tails for aggregates. The agent also
ships each line as an `access` record. Its body is `GET /path 502 1234ms`, and its attributes are `http.method`,
`http.route`, `http.status`, `duration_ms`, `bytes`, `client.ip_hash`, `user_agent.family`, `request_id`. Caddy
injects `X-Request-Id: {http.request.uuid}` upstream (keeping an incoming one when the site trusts it), so app lines
that log the header join the request. By default every non-2xx response and a configurable sample of 2xx responses
(default 10%) are shipped. Aggregates are still computed from 100% of lines, so traffic charts stay exact.

**OTLP logs (LP7).** The agent listens on loopback (the same listener as the `/tail` sink) for OTLP/HTTP logs, in
JSON first and protobuf after S4. Workloads get `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_SERVICE_NAME`, as DESIGN §8
promised. The node stamps `org`, `project`, `deployment` and `node`, and never trusts resource attributes for
tenancy. This fills the D16 receiver gap for logs, and metrics and traces can follow on the same listener.

**Platform logs (LP5).** The agent drains a fixed allow-list of units: `yoal-agent`, `yoal-helper`,
`yoal-control-plane`, `caddy`, `yoal-mail`, `yoal-clickhouse`, the registry unit and `yoal-builder`. Each is
scoped `platform` with `host.name` set to the node. Only platform admins see them. Platform logs are the first
place to look when a 5xx appears in the agent journal (memory: prod server runbook). Today that means SSH.

---

## 6. Query language

One grammar, called **log query** (LP3). It is parsed to an AST in `@yoal/contracts/log-query`, autocompleted from
the same AST, and compiled on the server. A user never sends SQL, except platform admins in the SQL tab (D101 rule).

### 6.1 Filters

```
timeout                         body contains "timeout" (token match; case-insensitive)
"connection reset"              phrase
level:error                     severity ≥ ERROR (level:warn means ≥ WARN; level:=warn means exactly WARN)
service:api  deployment:dep_…   built-in fields: scope, service, deployment, node, replica, source, stream,
                                build, job, pipeline, pod, pattern, trace, request
@http.status:>=500              attribute, with comparison operators > >= < <= on numbers
@user.id:123 @path:/api/*       wildcard
@msg:/time(out|d out)/          regex (ClickHouse only; marked in the UI)
-@path:/health                  negation, also NOT
a OR b, (a b) c                 boolean logic with implicit AND
```

### 6.2 Pipe stages (ClickHouse)

```
| fields ts, level, @http.status, body          choose columns
| stats count() by bin(5m), level              aggregate: count, count_distinct, avg, p50/p95/p99, min, max, sum
| stats p95(@duration_ms) by @http.route | sort p95 desc | limit 10
| patterns                                      group by template, with counts and sparklines
| dedup body                                    collapse repeats, with counts
| sort ts asc | limit 500
```

This deliberately follows CloudWatch Logs Insights' shape (`fields | filter | stats … by bin()`), so operators used
to AWS read it immediately. The filter syntax follows Datadog, Railway and Vercel so app developers do too.

### 6.3 Compilation

- **ClickHouse:** AST → parameterised SQL over `yoal.logs`, with `org_id` and the caller's permitted scopes ANDed in
  by `compileLogQuery(principal, ast)`. Run as `yoal_reader` with time, memory and row limits (D101).
- **SQLite (lite mode):** the same AST → a UNION over the adapters, supporting built-in fields, body substring
  (`instr`), level, time range and `| sort`/`| limit`/`| stats count() by bin()`. Anything else returns a typed
  `needs_clickhouse` error that the UI shows inline.
- **JS predicate:** AST → `(r: LogRecord) => boolean` for live tail and preview (§10.3).

### 6.4 Natural language

The assistant (L7) turns "errors from api in the last hour after the 14:00 deploy" into a log query, and shows it as
an editable query with the prompt kept as a comment, CloudWatch Query Assist style. It is never run automatically.

---

## 7. The Explorer

One Svelte component, `LogExplorer` (`apps/control-plane/src/lib/logs/`), built on the existing TanStack Query and
Virtual conventions. It mounts at `/logs`, where scope is open, and locked to a scope on project, database,
storage, broker, k8s, pipeline-job and function pages. Those pages lose their bespoke viewers.

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

### 7.2 Must-haves (L1–L2)

- **Scope tree** with counts: org → project or service → deployment or replica → stream. Platform scopes are shown
  to platform admins only.
- **Time picker**: relative (`15m`, `1h`, `24h`, `7d`), absolute, "around this time ±5 m", a UTC/local toggle, and
  brush-zoom on the histogram.
- **Histogram** stacked by level, with deploy markers (from `deployments`), alert-fired markers and node-event
  markers.
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
- **Saved queries**: personal or org, with name, query, scope, time and columns. They appear in the palette and can
  be turned into alerts or panels (§9).
- **Download**: NDJSON or CSV of the current query, capped at 100,000 rows (a larger export is a drain).

### 7.3 Keyboard

`/` focus query · `⌘↵` run · `j`/`k` move · `o` or `↵` expand · `c` context · `f` filter to the focused value ·
`x` exclude it · `space` pause or resume tail · `t` time picker · `[`/`]` previous or next time window ·
`⌘K` palette (saved queries, scopes, "go to deployment…") · `?` help. The keys are deliberately vim-adjacent,
like the HyperDX TUI.

---

## 8. Analysis

### 8.1 Patterns (LP8)

The indexer runs an online Drain miner (fixed-depth parse tree; He et al. 2017) per `(org, scope)`. It masks
numbers, UUIDs, hex, IPs, durations, quoted strings and paths, and stores `pattern_id` on each row. Templates live in
`yoal.log_patterns` (`pattern_id`, `scope`, `template`, `first_seen`, `last_seen`, `sample_id`). The miner is capped
per scope (LRU at 5,000 templates) and rebuilt from the last hour on restart. The Patterns tab is
`| patterns`: the template with masked placeholders highlighted, a count, a sparkline, and first-seen. Row actions
are "only this pattern" and "hide this pattern" (Better Stack). S3 measures the cost per line in Bun.

### 8.2 Compare

Compare runs the same query over two windows: the previous period, the same time yesterday or last week, or
**before and after a deploy** (deploy-aware compare). It shows patterns that are **new, rising, falling and gone**,
with deltas. That is CloudWatch's Compare, made deploy-aware. "What did this deploy change in my logs?" is the
single most useful question a PaaS log tool can answer.

### 8.3 Why? (field differences)

Brush a region of the histogram and choose **Why?**. The selection is compared against the rest of the window across
every built-in field and the top attribute keys, by value share. The result is a ranked list such as
"`node = edge-b` is 92% of the selection vs 31% baseline", "`deployment = dep_x` 100% vs 0%" and
"`@http.route = /v1/orders` 88% vs 12%". This is Honeycomb BubbleUp's idea, implemented as two `topK` queries per
key on ClickHouse.

### 8.4 Analytics

`| stats` results render as a time series when grouped by `bin()`, otherwise as a table or bar chart, using the D101
panel renderers. "Add to dashboard" copies the query into a panel (§9.2).

---

## 9. Acting on logs

### 9.1 Log alerts (extends D109)

Two new rule kinds sit on the existing alert-rule machinery and notifiers (ALERTS.md):

- **`log_count`**: a saved query's count over a window crosses a threshold (`level:error service:api > 50 in 5m`).
  It is evaluated by the existing rule loop as a ClickHouse count, and in lite mode as a SQLite count.
- **`log_pattern_new`**: a pattern never seen before in the scope appears at least N times. It can be limited to the
  30 minutes after a deploy. This is noise-resistant in a way keyword alerts are not.

Alert payloads carry an Explorer link with the query, scope and time window filled in.

### 9.2 Log-based metrics and panels

- A **log metric** is a saved query plus `| stats` turned into a series. It is computed at query time from
  `yoal.logs` (no materialisation until S1 shows a need). It appears in the dashboard builder as a new **`logs`
  dataset**, so builder panels can count log lines with the caller's scope ANDed in.
- A **Logs panel** type in dashboards shows a live, scoped, saved query inline.

### 9.3 Pivots

| From | To |
|---|---|
| Log row with `request_id` | every line of that request across edge and app; the edge access record |
| Log row with `trace_id` | all lines in the trace; an external trace UI link if one is configured (later, Yoal's own trace store) |
| Log row | its deployment, build, node, replica, job run or pipeline step |
| Traffic chart 5xx spike | Explorer with `source:access @http.status:>=500` over the brushed window |
| App error event (APP-ERRORS) | lines from the same project ±60 s, the same `request_id` when present |
| Alert instance | the rule's query at fire time |
| Deployment page | "Logs for this deploy" and "Compare with previous deploy" |

---

## 10. Cost, retention and safety

### 10.1 Retention tiers (LP9)

| Tier | Store | Default | Configurable |
|---|---|---|---|
| Hot tail | SQLite | 3 days with ClickHouse, 7 without | 1–14 days, per org |
| Search | ClickHouse `yoal.logs` | 14 days | 1–90 days, per org, and per project within the org's maximum |
| Archive | Parquet in the object store, daily per org | off | 30–400 days |

The archive reuses the telemetry Parquet job (DESIGN §8). **Rehydrate on query**: when a time range reaches into the
archive, the Explorer shows an estimate ("scans ~1.2 GB, ~20 s") and runs it only after confirmation, through
ClickHouse's `s3()` table function with a per-query scan budget (Datadog's rehydration, without a copy step).
Platform logs follow a platform policy.

### 10.2 Quotas (QUOTAS.md)

Per project there is an ingest rate (lines/s, burst) and a daily byte budget, and per scope a row cap in the hot
tail. These replace the global 500,000-row cap. Over-quota lines are dropped at ingest and counted, and one
`system` record per minute says "dropped N lines (quota)". The usage page shows log GB/day per project, for
showback.

### 10.3 Exclusion and sampling

An org or project rule is a log query plus an action: **drop**, or **sample N%**, or **index only**, which keeps the
line in the hot tail and drains but not in ClickHouse. Rules apply at the indexer, except drop rules, which apply at
ingest so drains honour them too. Before saving, the UI **previews** the rule against the last 15 minutes of live
tail: "would drop 41% of lines, mostly pattern 'GET /health 200'". Datadog has exclusion filters but no preview.

### 10.4 Redaction (LP10)

Redaction runs at ingest, before SQLite, drains and the indexer:

- Built-in detectors: JWTs, `Bearer` tokens, AWS and GCP key shapes, Yoal API and node tokens, URLs with
  `user:password@`, `Authorization`/`Cookie` header values, and long high-entropy strings in `key=` positions. Each
  match becomes `[REDACTED:kind]`.
- **Known secret values**: the project's secret env values, matched as the pipeline masker does (D152), using hashed
  n-gram prefilters so the control plane does not decrypt secrets on the hot path. S5 decides how.
- Org regex rules, with a preview like the one for exclusion rules.

### 10.5 Access

| Permission | Covers |
|---|---|
| `logs:read` (existing) | records in the scopes the principal can read: project, environment and the new resource kinds (database, storage, broker, k8s, function) |
| `logs:query` (new) | pipe stages and Why? (cost control for API keys); granted to developer and viewer by default |
| `logQuery:*` (new resource) | saved queries |
| platform admin | `platform` and `edge` scopes for the whole install, and the SQL tab |

Reads of platform logs are written to the audit log as `logs.read_platform`. Tenant reads are not audited (too
noisy), but MCP reads already are, as `mcp.<tool>`.

---

## 11. Phases

| Phase | Delivers | Exit criteria |
|---|---|---|
| **L0** Spikes | S1–S5 (§12) | numbers recorded in this doc; LP2 and LP8 confirmed or changed |
| **L1** One model, one viewer | `LogRecord` + `log-query` grammar (parser, AST, JS predicate, SQLite compiler) in contracts; `LogStore` seam with a SQLite adapter over every existing table; `GET /api/v1/logs` (scope, time range, query, cursor) + `/api/v1/logs/stream` (SSE over the in-process bus); `LogExplorer` replaces `LogsPanel`, `ServiceLogs`, `PodLogs`, `JobLogs`; `/logs` nav entry; per-scope caps replace the global cap; `yoal logs [scope] -q --since --until -f --json`; MCP `query_logs` | every existing viewer's feature set is preserved (step grouping for pipelines); tail no longer polls SQLite; e2e on mac-dev and linux-box |
| **L2** Search index | `yoal.logs` + indexer cursors; multiline at the agent; JSON/logfmt parse, severity, ids; facets, autocomplete from field stats; context; saved queries; histogram markers; lite-mode messaging | 24 h project query < 1 s and histogram < 1.5 s at 10 M rows under a 768 MiB cap; ClickHouse outage → tail unaffected, index catches up |
| **L3** Every source | platform units (admin); edge request records + `X-Request-Id`; agent OTLP/HTTP logs receiver; function tails exploded; audit and email as read-only sources; `log_records` table | a request is traceable edge → app in one click; platform 5xx investigation without SSH |
| **L4** Analysis | Drain patterns; `\| stats`, `\| patterns`, `\| dedup`; Analytics tab; Compare (including deploy-aware); Why? | "what changed after deploy X" answered with no typing |
| **L5** Act | `log_count` and `log_pattern_new` alert rules; `logs` dashboard dataset and Logs panel; pivots from traffic, app errors, alerts and deploys | an alert link opens the exact window and query |
| **L6** Cost and safety | retention tiers + Parquet archive + rehydrate with estimate; quotas + drop counters; exclusion and sampling with preview; redaction rules; platform read audit | a noisy project cannot evict another's logs; secrets in a test app never reach storage |
| **L7** Assistant and agents | NL → query; "explain this pattern" and "summarise errors in this window"; MCP `get_log_patterns`, `get_log_context`, `compare_logs`; the per-resource MCP log tools become thin wrappers | the assistant answers "why did api 500 at 14:02" with linked evidence |

L1 is useful on its own and does not need ClickHouse. Each later phase is shippable behind a feature flag in the
`YOAL_FEATURE_*` style.

---

## 12. Spikes

| ID | Question | Pass criteria |
|---|---|---|
| S1 | Does ClickHouse 26.8's `text` index (GA 2026-03) work under the 768 MiB default cap with 10–50 M rows of realistic logs? `Map` vs `JSON` for attributes; `tokenbf_v1` fallback | token search on a 24 h project scope < 1 s; merges stay under the cap; on-disk bytes per line recorded |
| S2 | SQLite and Litestream cost at sustained 500 and 2,000 lines/s through `/api/agent/logs` | p99 state-write latency unchanged within 10%; otherwise move log tables to an unstreamed `logs.db` |
| S3 | Drain miner cost in Bun (TS) per line, and memory per 5,000 templates | < 20 µs per line p50; < 50 MB per 100 scopes |
| S4 | OTLP/HTTP protobuf decode in Bun without a native addon (`protobufjs` or a generated decoder) | 10 k records/s per core; JSON path shipped first regardless |
| S5 | Known-secret redaction without decrypting on the hot path | design that matches every secret value ≥ 8 chars with < 5 µs per line overhead |

---

## 13. Proposals

Each becomes a D-number when built. Check the tail of DECISIONS.md for the next free ID (D243 on 2026-11-25).

| ID | Proposal |
|---|---|
| LP1 | **One OTel-shaped `LogRecord` for every source**, with Yoal scope `{kind, id}`, stream, severity number, attributes, resource, and trace and request IDs. Existing tables map through adapters; new sources write `log_records`. |
| LP2 | **SQLite stays the write path and hot tail; ClickHouse `yoal.logs` is a derived search index** fed by an idempotent cursor indexer. Logs never depend on ClickHouse being up. (Supersedes FEATURE-RESEARCH's "log warehouse: do not build" row.) |
| LP3 | **One log-query grammar** (filters + Insights-style pipe stages) in `@yoal/contracts`, compiled on the server with tenancy ANDed in. Raw SQL is for platform admins only (as in D101). |
| LP4 | **Live tail is an in-process bus with per-subscriber compiled predicates**, resumable by seq vector. No polling. |
| LP5 | **Yoal's own service logs are the `platform` scope**, drained from a fixed unit allow-list. Platform admins only, and reads are audited. |
| LP6 | **The edge injects `X-Request-Id` and ships access records**: all non-2xx plus a 2xx sample. Aggregates still use 100% of lines. |
| LP7 | **The agent runs an OTLP/HTTP logs receiver on loopback**. Workloads get `OTEL_EXPORTER_OTLP_ENDPOINT`, and the node stamps tenancy. |
| LP8 | **Patterns are mined at index time** (Drain) and stored as `pattern_id`, so patterns, compare and `log_pattern_new` alerts are plain GROUP BYs. |
| LP9 | **Retention is three tiers per org and project** (hot tail, search, archive with rehydrate-on-query), and **quotas are per project**, replacing the global row cap. |
| LP10 | **Redaction runs at ingest**, before storage, drains and the index: built-in detectors, known secret values and org rules. |
| LP11 | **One `LogExplorer` component everywhere**, with all state in the URL. Bespoke log viewers are removed. |
| LP12 | **Log alerts are alert-rule kinds** (`log_count`, `log_pattern_new`) on the D109 machinery and notifiers. |

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
- **State DB load** from log volume (S2). Mitigation: a `logs.db` split.
- **Redaction misses.** No detector is complete. Document it as defence in depth, never as a guarantee, and keep
  "Purge lines matching…" as an admin action across both stores.
- **Cross-tenant leakage through new query features.** Every compiler path takes the principal. Contract tests
  assert that a query naming another org's scope returns nothing and does not error in a way that leaks existence.

**Decided (Kieran, 2026-11-25)**

1. **ClickHouse stays optional.** Without it the Explorer runs in lite mode over SQLite, and `/logs` shows a banner
   linking to Settings → Telemetry. No install is nudged by node count.
2. **Platform logs are for platform admins only** (LP5). Org owners do not see them, even for nodes that run only
   their org's workloads.
3. **Edge 2xx sampling defaults to 10%** (LP6). Every non-2xx response is always shipped, and 100% per site is a
   toggle.
4. **The archive tier is off by default** (LP9). An owner opts in.
5. **Adapters first.** L1 reads the sibling tables through adapters. Folding them into `log_records` waits until
   after L3.

---

## Appendix: research

What other products contribute, and what this plan takes from each:

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

Most vendor details above came from documentation search results rather than full reads. Before a proposal relies
on a vendor behaviour (rather than only borrowing the idea), check it at its source. The ClickHouse text-index facts
are re-verified in S1.
