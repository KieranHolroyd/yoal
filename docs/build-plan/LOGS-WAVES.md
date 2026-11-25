# Logs Explorer — build waves

Execution plan for [docs/LOGS.md](../LOGS.md) (agreed 2026-11-25, §15). The spec is LOGS.md. This file holds the lane
briefs, ownership and merge order. Lanes run in parallel git worktrees on branches `logs/<lane>` and merge into local
`main` in the order given.

## Foundation (merged before Wave 1)

| File | What |
|---|---|
| `packages/contracts/src/log-record.ts` | `LogRecord`, scopes, severity helpers, REST/SSE input and result shapes, saved queries, `nodeLogBatchSchema` |
| `packages/contracts/src/log-query-ast.ts` | query AST, built-in fields, limits |
| `packages/contracts/src/log-query.ts` | **placeholder** parser, predicate and formatter with stable signatures (Lane Q replaces it) |
| `packages/core/src/log-store/types.ts` | `LogStore` seam, `LogReadBoundary`, `LogStoreRead`, `LogStoreUnsupported` |
| `packages/core/src/log-store/sqlite-sources.ts` | per-table SELECTs projecting the unified columns, `unifiedRowToLogRecord`, id helpers (tested) |
| `packages/db/migrations/0142_logs_explorer.sql` | `log_records`, `log_index_cursors`, `log_saved_queries`, `log_rules`, `log_settings`, `log_drop_counts` (+ schema.ts) |

## Rules for every lane

- Work only inside your worktree, and run `bun install` there first. Read `docs/LOGS.md` in full, then your brief.
- Edit only the files your lane owns (below). If you must touch a shared file (`packages/core/src/index.ts`,
  `context.ts`, `mcp.ts`, `schema.ts`, nav files), keep the edit small and additive so merges stay clean.
- **No new migrations in Wave 1.** 0142 already has the tables. If you truly need a column, say so in your report
  instead.
- Keep the foundation signatures stable. Only Lane Q rewrites `log-query.ts`.
- House style: tabs, plain-English comments that cite `docs/LOGS.md §n`, no CHECKs on open vocabularies, and
  tenancy always taken from the server (`LogReadBoundary`).
- Verify before you report: `bun run check` in every package you touched (`packages/contracts`, `packages/core`,
  `apps/control-plane`, `apps/agent`, `apps/helper`, `apps/cli`), plus `bun test <your paths>` and the existing
  tests next to anything you edited. Add tests for new behaviour.
- Commit on your branch (`logs(<lane>): …`), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  Do not push. Do not edit `VERSION`, `docs/DECISIONS.md` or `docs/LOGS.md`: integration assigns D-IDs and
  updates the docs.
- Report: what you built (file list), test and check results, anything deferred or deviating from the spec, and
  every shared file you touched.

## Wave 1 (parallel)

### Q: query language (contracts)
Owns `packages/contracts/src/log-query.ts`, `log-query.test.ts`, and `log-query-suggest.ts` (+ test).
- Replace the placeholder. `parseLogQuery(text)` implements LOGS.md §6.1–6.2 exactly:
  - bare tokens and "phrases" (with `\"` escapes)
  - `field:value`, `field:"quoted"`, `field:>=n` / `>` / `<` / `<=`, `field:=value` (exact level), `field:val*`
    wildcards, `field:/regex/`, `@attr.key:…`, `resource.key:…` / `@resource.key:…`, `@key:*` exists
  - `-x` / `NOT x`, implicit AND, `OR`, parentheses
  - pipes: `| fields a, b`; `| stats <agg>[ as alias], … [by bin(5m)[ as t], field, …]` with every
    `LogAggregationFn` (`count()`, `count_distinct(f)`, `p95(f)`…); `| patterns`; `| dedup f`;
    `| sort key [asc|desc]`; `| limit n`
- Enforce `LOG_QUERY_LIMITS`. Errors carry start/end offsets and a hint for unknown fields (did-you-mean over
  `builtinLogFields`). Field names are case-insensitive. `message` is an alias for `body`. `level:warn` is
  `gte`, and `level:=warn` is `eq`.
- `formatLogQuery(ast)` gives canonical text that round-trips (property-style tests).
- `compileLogPredicate(filter)` is the full JS evaluator over `LogRecord`, with the same semantics the SQL
  compilers must have: case-insensitive substring for text, glob for wildcard, `RegExp` for regex (guarded:
  invalid → never matches), numeric compares parse the value, missing field → false (true under NOT), and
  `service` matches `scopeName`, `project` matches `projectId` or `scopeName`.
- `requiredLogFeatures(ast)` returns `regex`, `attributes` (any attribute/resource field), `stats` (stats,
  dedup, fields), and `patterns` (the patterns stage or `pattern:` field).
- `log-query-suggest.ts` exports `suggestLogQuery(text, caret, catalog)` → completion items (field names, values
  from a provided `{ field → values[] }` catalog, operators, pipe stages, aggregation functions) plus the token
  range to replace. It is pure, so the UI and CLI can both use it.
- Thorough tests: every syntax form, precedence, errors, limits, predicate semantics, round-trips.

### S: lite store, explorer service, REST and SSE (core + control-plane API)
Owns:
- `packages/core/src/log-store/sqlite-store.ts` (+ test)
- `packages/core/src/log-store/sqlite-compiler.ts` (+ test)
- `packages/core/src/log-explorer.ts` (+ test)
- `packages/core/src/log-tail-bus.ts` (+ test)
- `packages/core/src/log-saved-queries.ts` (+ test)
- `apps/control-plane/src/routes/api/v1/logs/**`
- small additive edits to `packages/core/src/logs.ts`, `index.ts` and `context.ts`, and to the IAM catalog and
  permissions

The work:
- **`SqliteLogStore implements LogStore`.** UNION ALL of the `SQLITE_LOG_SOURCES` SELECTs, keeping only sources
  whose `scopeKinds` intersect the boundary. It ANDs `org_id` and `(scope_kind, scope_id) IN boundary`, the time
  range and the compiled filter. It uses keyset cursors on `(ts, tag, seq)` encoded opaquely, both directions.
  - Lite-mode compiler: built-ins, body text (`instr(lower())`), level bands, wildcard (`LIKE` with escaping),
    numeric compares on `replica`.
  - Attribute fields work on `log_records` / `pipeline_log_lines` via `json_extract`. Elsewhere they are NULL,
    so they simply don't match. Regex throws `LogStoreUnsupported('regex')`.
  - `table()` supports `| stats count() by bin(x)[, level|source|scope…]`, `| sort`, `| limit`, and throws
    for the rest.
  - `histogram`: bucketed `GROUP BY` severity. `fields`: top values for the built-ins only. `context`: same
    tag + stream (or scope when stream is null), by seq. `get`.
- **`LogExplorerService`** (`core.logExplorer`):
  - Resolves the `LogReadBoundary` from a principal: `logs:read` on each scope via `ctx.iam`, covering projects
    and environments the principal can read, plus databases, storage, brokers, k8s clusters, pipelines
    (repositories) and functions in the org. `platform` and `edge` scopes are for platform admins only
    (decided). It intersects requested scopes with what is allowed, and an empty result means no access.
  - Parses with `parseLogQuery`, picks the store (ClickHouse when `ctx.logStoreClickhouse` is set and healthy,
    otherwise SQLite; leave that hook as an optional context field Lane I fills), maps `LogStoreUnsupported` to
    a `needs_clickhouse` warning or a 422, fills `scopeName` with a batched lookup, and adds histogram markers
    (deployments in range for the scopes; alert instances if cheap).
  - Also: `capabilities()`, saved-query CRUD (`logQuery` resource; personal visible to the owner only, org to
    `logs:read` holders, writes need ownership or org admin), and an audit entry `logs.read_platform` when a
    platform scope is read.
- **Tail bus.** `LogService.append*` (all variants, plus a new `appendRecords` hook Lane N1 calls) publishes
  inserted rows, mapped through `unifiedRowToLogRecord`, to an in-process `LogTailBus`. Subscribers register a
  boundary and a predicate (`compileLogPredicate`), each with a bounded queue (2,000), and emit `sampled` when
  they overflow. Resume: the SSE route takes `Last-Event-ID` (an opaque cursor), does a SQLite catch-up through
  `SqliteLogStore.search(order: 'asc')`, then switches to the bus. Make the append paths return or collect
  inserted seqs to publish without a re-read where practical.
- **Per-scope caps** replace the global 500,000-row cap in `LogService.prune`: 100,000 rows per scope per table
  for the newest rows (configurable constant), plus age. `log_records` is pruned too.
- **REST**:
  - `GET|POST /api/v1/logs/search`, `/table`, `/histogram`, `/fields`, `/context`, `/capabilities`
  - `GET /api/v1/logs/stream` (SSE; events per `LogTailEvents`; heartbeat 15 s)
  - `GET|POST /api/v1/logs/saved`, `PATCH|DELETE /api/v1/logs/saved/:id`

  Inputs are validated with the contract schemas, and scopes are passed as repeated `scope=kind:id` (GET) or a
  JSON body (POST). Use the existing `route`/`json` helpers and principal resolution, so both session cookies
  and API keys work. Follow how other `api/v1` routes are laid out.
- **IAM.** Add `logs:query` (granted wherever `logs:read` is, by default) and a `logQuery` resource with CRUD in
  the catalog. Keep `scripts/lint-iam.ts` passing.
- Keep the old per-resource endpoints and `LogService.query` working; Lane U moves the UI over. Tests cover
  tenancy: org A can never see org B, a project-only principal sees only its projects, and only platform admins
  see platform records.

### I: ClickHouse index (core)
Owns:
- `packages/core/src/log-store/clickhouse-store.ts`, `clickhouse-compiler.ts`, `packages/core/src/log-indexer.ts`,
  `packages/core/src/log-enrich.ts` (all + tests)
- additive DDL in `packages/core/src/telemetry.ts`
- control-plane wiring of the indexer tick

The work:
- **DDL.** `yoal.logs` per LOGS.md §4.2: `DateTime64(3)` timestamps (ms, matching the contract),
  `Map(LowCardinality(String), String)` attributes and resource, a `pattern_id String`, and the `text` index
  (`TYPE text(tokenizer = 'splitByNonAlpha')`) with a `tokenbf_v1` fallback chosen at create time when the
  server rejects `text`. Partition by day, `ORDER BY (org_id, scope_kind, scope_id, ts)`, and a TTL backstop of
  90 days. Also `yoal.log_patterns` (ReplacingMergeTree keyed by `(org_id, scope_kind, scope_id, pattern_id)`).
  Create them where the other tables are created.
- **`log-enrich.ts` (pure).** `enrichRecord(record)`:
  - JSON-object or logfmt (≥2 pairs) body → attributes, flattened with dots, values stringified, at most 64 keys
    and 4 KiB each.
  - Body → `msg` / `message` / `event` / `error` when present.
  - Severity from `level` / `severity` / `lvl` / `log.level` via `severityForText`.
  - `trace_id` from `traceparent`, `trace_id`, `traceId`, `dd.trace_id`; `span_id` likewise.
  - `request_id` from `request_id` / `requestId` / `req_id` / `x-request-id` / `http.request_id`.

  Reuse `parseLogLine` where it helps.
- **`LogIndexer`.** One cursor per `SQLITE_LOG_SOURCES` table in `log_index_cursors`. Each pass reads up to 5,000
  rows after the cursor, maps them with `unifiedRowToLogRecord`, enriches them, optionally runs a
  `PatternMiner` (`{ patternFor(scopeKey: string, body: string): { id: string; template: string } }`, injected
  later by integration from Lane D; null → empty `pattern_id`), and inserts with
  `insert_deduplication_token = <table>:<from>-<to>` (enable `non_replicated_deduplication_window` on the table).
  It moves the cursor only after the insert succeeds, records `indexed_ts` and `last_error`, and backs off on
  failure. It is fail-open and off when telemetry is not installed. Kill switch: feature flag `LOG_INDEX`
  (default on, in `packages/contracts/src/features.ts`; update docs/OPS.md §2.5 only if that list is the
  registry's documented mirror). Start from `max(seq) − N` hot rows on first run, so it never reindexes years.
  Expose `lagMs()`.
- **`ClickHouseLogStore implements LogStore`.** It compiles the AST to parameterised SQL (never interpolate user
  strings; use ClickHouse query parameters `{p0:String}`) with `org_id` and the boundary scopes ANDed in.
  - Text uses `hasToken`/`hasTokenCaseInsensitive` when the value is one alphanumeric token and the text index
    exists, otherwise `positionCaseInsensitive`.
  - Wildcard uses `ILIKE`, regex uses `match()` (with a regex-length limit), attributes use
    `attributes['k']`, and numeric compares use `toFloat64OrNull`.
  - Full pipe support: `fields`, `stats` (every agg via `count`/`uniq`/`sum`/`avg`/`min`/`max`/`quantile(…)`,
    `bin()` via `toStartOfInterval`), `patterns` (`GROUP BY pattern_id` joined to `log_patterns` for the
    template, with a sample id via `any(id)`), `dedup` (`LIMIT 1 BY`), `sort`, `limit`.
  - `histogram`, `fields` (top values for built-ins plus `mapKeys` discovery of the top 30 attribute keys, with
    sparklines), `context` (same `stream`, ordered by `ts`, `id`), `get`.
  - Run as the reader with the `AD_HOC_LIMITS` style settings.
- **Wiring.** Set the optional `ctx.logStoreClickhouse` and `ctx.logIndexer` (add these to `CoreContext` as
  optional fields; Lane S reads `logStoreClickhouse`). Register the indexer tick wherever the control plane runs
  telemetry background loops.
- Tests: compiler snapshot tests for every node and pipe (tenancy always present), enrichment tests, and an
  indexer test with a fake ClickHouse client (cursor moves only on success; dedup token stable on replay). If
  `bun run dev:clickhouse` works locally, run an integration test against it and record S1-style numbers (10 M
  synthetic rows, token-search latency, bytes per row, memory) in your report.

### N1: node sources part 1 (multiline, platform units, record ingest)
Owns:
- `apps/agent/src/log-drain.ts` and a new `apps/agent/src/platform-log-drain.ts`
- helper journal reading for platform units (`apps/helper/src/systemd.ts` additions and server route)
- `apps/control-plane/src/routes/api/agent/log-records/+server.ts`
- `LogService.appendRecords` in `packages/core/src/logs.ts`, in a separate method block (Lane S edits other parts
  of the file)

The work:
- **Multiline join in the agent drain (§4.3.1).** Before posting, join continuation lines to the previous line of
  the same unit: leading whitespace plus `at `, `Caused by:`, `Traceback (most recent call last):`, `File "…"`
  frames, `^\s+\.\.\. \d+ more`, and lines starting with a tab. Cap a joined record at 16 KiB / 200 lines and
  flush on a 1 s gap or at batch end. Pure, tested function.
- **Platform unit drain (LP5).**
  - A helper verb reads journald for a fixed allow-list (`yoal-agent`, `yoal-helper`, `yoal-control-plane`,
    `yoal-builder`, `caddy`, `yoal-mail`, `yoal-clickhouse`, `yoal-registry`, or whatever the real unit names
    are; find them in the installer and unit files) with the same cursor and limit rules as workload logs. It
    never takes arbitrary unit names.
  - The agent polls every 5 s and posts `nodeLogBatchSchema` with `target: { kind: 'platform', unit }` to
    `/api/agent/log-records`.
  - Kill switch: flag `PLATFORM_LOGS` (default on).
  - The agent persists the journald cursor per unit to its state dir, so restarts don't re-ship.
- **Ingest route + `LogService.appendRecords(nodeId, batch)`.** It authenticates the node. Target resolution:
  - `workload` → the project (same rules as `appendRuntime`, including the replica / runs-on-node check)
  - `site` host → the project that owns the domain/route (find the domain table)
  - `platform` → `scope { kind: 'platform', id: nodeId }`, `org_id` = the platform's owning org, or a sentinel
    `'platform'`; document which

  It writes `log_records` (JSON attributes/resource, stream `unit:<name>` / `deployment:<id>` /
  `site:<host>`, `observed_ts = now`), sanitizes bodies like `sanitize()`, and counts `dropped` into
  `log_drop_counts` (reason `node`). Return `{ ok, stored }`. Call an optional `this.onAppend?.(…)` hook so
  Lane S's bus can subscribe (coordinate by name: Lane S adds `LogService.onAppend` as a list of listeners
  receiving `UnifiedLogRow[]`; if it is not present in your tree, add the minimal listener array yourself with
  exactly that name and shape).
- Tests for the join function, target resolution, cross-node refusal, and the cursor persistence.

### N2: node sources part 2 (edge requests, request ids, OTLP)
Owns:
- `apps/agent/src/caddy-config.ts` (request-id injection)
- the access shipping additions in `apps/agent/src/telemetry.ts` (`AccessLogTailer` consumer)
- a new `apps/agent/src/otlp-logs.ts`
- workload env injection (find where `OTEL_*` or workload env is built, in helper or agent)

The work:
- **`X-Request-Id` (LP6).** Caddy sets `X-Request-Id` upstream to the incoming header when the site trusts proxies,
  otherwise `{http.request.uuid}`, and echoes it in the response, and the access log carries it. Keep the
  existing route JSON shape and tests passing.
- **Access records.** From the same tailed access lines that feed the aggregates (aggregates still see 100%), build
  `NodeLogRecord`s:
  - source `access`, body `METHOD path status durationms`
  - attributes `http.method`, `http.route`/`http.path`, `http.status`, `duration_ms`, `bytes`, `client.ip_hash`
    (the same hash the aggregator uses), `user_agent.family` (cheap classifier), `http.host`, `request_id`
  - severity: 5xx error, 4xx warn, else info

  Ship every non-2xx/3xx line and a sample of 2xx/3xx at the **site's rate, default 10% (decided)**. The rate
  comes from desired state if present, otherwise the default; leave a `sampleRate` hook. Batch per host to
  `/api/agent/log-records` with `target: { kind: 'site', host }` and `dropped` = the sampled-out count. Kill
  switch: flag `EDGE_REQUEST_LOGS` (default on). Note the access log is off unless `YOAL_CADDY_ACCESS_LOG` is
  set; do not change that default, but document in your report what enabling it takes.
- **OTLP/HTTP logs receiver (LP7).**
  - `POST /v1/logs` with JSON encoding (`ExportLogsServiceRequest`) on the agent's existing loopback listener that
    serves the `/tail` sink (find it in `analytics-sink.ts`). Protobuf (`application/x-protobuf`) gets a clear
    415 for now.
  - The workload is identified the same way the tail sink identifies callers. If it cannot be, use the
    `service.instance.id` / `yoal.workload.id` resource attribute only when it maps to a workload on this node.
    The node never trusts tenancy beyond that.
  - Map to `NodeLogRecord`: severityNumber, body (stringify structured), attributes flattened, resource, traceId
    and spanId as hex.
  - Post with `target: { kind: 'workload', workloadId }`.
  - Inject `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` and `OTEL_SERVICE_NAME` (project
    slug) into process and container workloads when the flag `OTLP_LOGS` is on (default on). Never override
    user-set values.
- Tests for the record builder and sampler, the OTLP JSON mapping (spec fixtures), Caddy config snapshots, and env
  injection.

### D: pattern miner and redaction (pure modules)
Owns `packages/core/src/log-patterns.ts` and `packages/core/src/log-redaction.ts` (+ tests and a bench script
under `packages/core/bench/` or `spikes/`).
- **`DrainMiner`** (He et al. 2017): masking (numbers, hex ≥8, UUIDs, IPv4/IPv6, durations like `120ms`/`1.2s`,
  ISO timestamps, quoted strings, URLs/paths with ≥2 segments, emails), a fixed-depth tree (depth 4), a
  similarity threshold of 0.4, a max of 100 children per node, and per-scope LRU at 5,000 templates.
  - `patternFor(scopeKey, body)` → `{ id, template }`. The id is a stable hex hash of the template, so the same
    template has the same id across restarts and nodes.
  - `snapshot()` / `restore()` for warm restarts.
  - Template tokens use `<NUM>`, `<HEX>`, `<UUID>`, `<IP>`, `<DUR>`, `<TS>`, `<STR>`, `<PATH>`, `<EMAIL>`, `<*>`.
  - Bench S3: 1 M realistic lines (mixed web, db and stack traces) → p50/p99 µs per line and memory for 100
    scopes. The target is <20 µs p50.
- **`createRedactor(options)`** → `redact(text) → { text, hits: kind[] }`:
  - built-in detectors from LOGS.md §10.4 (JWT, Bearer, AWS `AKIA…`/secret shapes, GCP key JSON fragments,
    GitHub/GitLab tokens, Yoal token prefixes (find them in the code: API keys, node tokens), URL userinfo
    passwords, `Authorization`/`Cookie`/`Set-Cookie` values, `password=`/`secret=`/`token=`/`api_key=` values,
    private key blocks)
  - known secret values: given a list of secret strings (≥8 chars), mask any occurrence, using a fast prefilter
    (e.g. Aho–Corasick or first-4-char set) so the cost per line stays low with 500 secrets
  - org regex rules (compiled once, with a timeout guard via length caps)
  - replacement `[REDACTED:<kind>]`

  Bench S5: overhead per line with 0/50/500 secrets. The target is <5 µs p50 with 50 secrets.
- Thorough tests with false-positive checks (hashes in normal logs, UUIDs, git SHAs must NOT be redacted).

### U: the Explorer UI (control-plane dashboard)
Owns:
- `apps/control-plane/src/lib/logs/**` (components, API client, URL state, keyboard)
- `apps/control-plane/src/routes/(dashboard)/logs/**`
- the swaps on resource pages (project Logs tab, database, storage and broker logs pages, Kubernetes logs page,
  pipeline job logs)
- nav entries (`_lib/subnav.ts` and the top-level nav)

The work:
- Read the memory-equivalent conventions in the code first: SvelteKit, shadcn-svelte, TanStack
  Query/Table/Virtual (`@tanstack/svelte-virtual` is already used by `LogsPanel`), `$app/env`, and how other pages
  fetch `api/v1` with the session. Look at the dashboards feature (`(dashboard)/dashboards/**`) for the chart
  approach, and reuse its renderer for the histogram if it fits. Otherwise use a small inline SVG bar chart; do
  not add a heavy chart dependency.
- Build `LogExplorer.svelte` per LOGS.md §7, against the REST/SSE contract in `log-record.ts` (Lane S implements
  it in parallel; code to the contract and the route paths in Lane S's brief):
  - scope bar (picker from `/capabilities`, locked when embedded)
  - query editor with syntax highlighting, inline parse errors from `parseLogQuery`, autocomplete from
    `suggestLogQuery` (import it; it lands from Lane Q, so guard on the placeholder) and `/fields` values,
    ⌘↵ to run
  - time picker (relative presets, absolute, UTC/local toggle) with `[`/`]` to shift
  - histogram stacked by severity, with brush-to-zoom and deploy markers (links)
  - mode tabs: Stream (Wave 1), with Patterns, Analytics and Compare as visible placeholders that call `/table`
    for `| patterns` / `| stats`. Minimal Wave 1 versions are fine; Wave 2 finishes them.
  - facet sidebar (top values with share bars; click to filter, alt-click to exclude; per-user hidden facets in
    `localStorage`)
  - virtualised stream with newest first, load older/newer by cursor, severity colours, wrap toggle, column
    chooser, ANSI rendering when `ansi` (a small ANSI-to-spans renderer), and search-term highlighting
  - row expansion flyout: all fields, raw JSON, copy, "filter to value", and pivots (deployment, build, node,
    request id → `request:<id>` query, trace id)
  - context view (`c`)
  - live tail toggle over `/api/v1/logs/stream`: pause on scroll or selection, an "N new" pill, `sampled` notice,
    reconnect with `Last-Event-ID`
  - saved queries (palette list, save dialog, personal/org)
  - download NDJSON/CSV (client-side from pages, capped at 100,000)
  - lite-mode banner when `capabilities.engine === 'sqlite'`, linking Settings → Telemetry; ClickHouse-only
    controls are disabled with a tooltip
  - keyboard map per §7.3 with a `?` help sheet
  - all state in the URL (`q`, `scope`, `from`/`to` or `range`, `mode`, `row`)
- **Swaps.** Each resource page mounts `LogExplorer` locked to its scope with a sensible preset query that keeps
  today's behaviour (project Logs tab: runtime + system, no job or build lines; deployment page: `deployment:<id>`;
  build view: `build:<id>`, which must still end/settle like today; pipeline job: `stream:pipeline-job:<id>`
  with step grouping preserved, either through a group-by-step toggle or by keeping `JobLogs` as a thin wrapper;
  database/storage/broker/k8s: their scope). Delete the replaced viewers only when nothing imports them.
- Add `Logs` to the top-level nav (gated by `logs:read`).
- `bun run check` in `apps/control-plane` (svelte-check) must pass. Add unit tests for the URL-state codec, ANSI
  renderer and CSV/NDJSON export (vitest or bun test, whichever the app uses).

## Wave 2 (after Wave 1 merges)

Briefs are written after the Wave 1 merge, against the merged code:

- **A, analysis (L4):** Patterns tab, Compare (windows + deploy-aware), Why? field diff, Analytics tab charts.
- **R, act (L5):** `log_count` / `log_pattern_new` alert rules, the dashboards `logs` dataset + Logs panel, and
  pivots from traffic, app errors, alerts and deployments.
- **C, cost and safety (L6):** retention tiers + Parquet archive + rehydrate estimate, quotas + drop counters,
  exclusion/sampling/index-only rules with preview, redaction wired at ingest (Lane D's module) with known-secret
  values, and Settings → Logs.
- **M, CLI, MCP and assistant (L7):** `yoal logs` on the unified API (`-q`, `--since`, `--until`, `-f`,
  `--json`, `--scope`, `patterns`, `context`), MCP `query_logs` / `get_log_patterns` / `get_log_context` /
  `compare_logs` (per the MCP surface rules), per-resource MCP log tools as wrappers, and assistant NL→query.

## Wave 3: integration

Merge, D-IDs for LP1–LP12, DESIGN §8 / API.md / MCP catalogue / CLI docs / OPS flags / FEATURE-RESEARCH row /
WHATS-NEW / LOGS.md status, the full test suite and checks, a review pass, and a run of the dashboard.
