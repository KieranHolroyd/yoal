---
title: Logs Explorer
description: Search, tail and analyse every log line in one place, with one query language for the dashboard, the CLI, the API and agents.
---

The Logs Explorer is where you read logs in Yoal: app output, builds, scheduled jobs, pipelines, databases, object storage, queue brokers, Kubernetes clusters, edge requests and, for platform admins, Yoal's own services. Every line is stored in the same shape, so one query language, one live tail and one set of tools covers all of them. This page explains the query syntax, the Explorer's modes, live tail, saved queries, alerts from logs, sending structured logs from your app, and what changes when the optional ClickHouse search index is installed.

## Opening the Explorer

Open **Logs** in the sidebar to search everything you can read across the organisation. Every resource page also has the Explorer built in, locked to that resource: a project's or function's **Logs** tab, a deployment, a build, a database, storage instance, broker, Kubernetes cluster or pod, and a pipeline job (which keeps its step grouping). The locked views start with a sensible query, for example a project's tab shows runtime and system lines without build or job output.

Reading logs needs the `logs:read` permission. Every built-in role has it, and it can also be granted for a single database, storage instance, broker, Kubernetes cluster or pipeline repository. Pipe stages, **Compare** and **Why?** also need `logs:query`, which every built-in role that reads logs has; it exists so that an API key can be limited to plain searches. A scope you cannot read is simply left out of the results.

## What is collected

| Source | Where it shows | Notes |
| --- | --- | --- |
| App output (process, container and compose apps, functions) | The project | Read from the app's journal every couple of seconds. Multi-line stack traces are joined into one record. |
| Builds and scheduled jobs | The project | Filter with `source:build` or `source:job`, or `build:<id>` and `job:<id>`. |
| Pipelines | The pipeline repository | Each job and step is a stream. |
| Databases, object storage, queue brokers | That service | The service's own log output. |
| Kubernetes | The cluster | Cluster lifecycle lines and pod logs. |
| Edge requests | The project that serves the host | Every request that did not return 2xx or 3xx, plus a 10% sample of the rest, with `source:access`. |
| OpenTelemetry logs from your app | The project | Structured records with attributes and trace ids. See [sending structured logs](#sending-structured-logs-from-your-app). |
| Yoal's own services | `platform` scopes | The agent, helper, control plane, Caddy, mail, ClickHouse, registry, builder and Litestream on each node. Platform admins only, and every read is audited. |

Each record has a time, a scope (the project or service it belongs to), a stream inside the scope (a deployment, build, job run, pipeline step, pod or unit), a source, a severity (`trace`, `debug`, `info`, `warn`, `error` or `fatal`), the message, and any attributes parsed from it. A line that is a JSON object, or `key=value` pairs, has its fields turned into attributes you can filter and group by, and its `msg`, `message`, `event` or `error` field becomes the message.

Before a line is stored, Yoal masks secrets it recognises: your organisation's secret values, tokens and keys with well-known shapes, passwords in URLs and `Authorization` or `Cookie` headers. A match is replaced with `[REDACTED:<kind>]`. This is a safety net, not a guarantee, so keep secrets out of your logs.

## Lite mode and the search index

The Explorer works on every install. With the optional telemetry store (ClickHouse, installed in **Settings → Telemetry**), Yoal also builds a search index of your logs and the Explorer can do more. Without it, the Explorer runs in **lite mode** over the recent log store and shows a banner saying so.

| | Lite mode | With ClickHouse |
| --- | --- | --- |
| Text search, built-in fields, levels, wildcards | Yes | Yes |
| Histogram, live tail, context, saved queries, export | Yes | Yes |
| `\| stats count() by bin(…)`, `\| sort`, `\| limit` | Yes | Yes |
| Attribute filters such as `@http.status:>=500` | Only on edge, OpenTelemetry and pipeline lines | Yes |
| Regular expressions, other `\| stats`, `\| patterns`, `\| dedup`, `\| fields` | No | Yes |
| Facets on attributes, Patterns, Compare, Why? | No | Yes |
| How far back | The recent log store (7 days by default) | 14 days by default, and an archive if one is turned on |

When a query needs the index and the install has none, the Explorer says so next to the query instead of showing a wrong answer. If ClickHouse stops answering, searches fall back to the recent log store with a note, and the live tail is never affected. New lines reach the index within seconds; if it falls behind, the Explorer shows how far.

## Query syntax

A query is a filter, optionally followed by pipe stages. Terms separated by spaces must all match.

```text
level:error service:api -@http.route:/health "connection reset"
```

### Text

| Query | Matches |
| --- | --- |
| `timeout` | Messages containing the whole word `timeout`, in any case. It matches `upstream timeout:` and `Timeout`, but not `timeouts` or `UpstreamTimeout`. |
| `"connection reset"` | Messages containing that exact text, in any case. Use `\"` for a quote inside. |
| `user@example.com` | A word with punctuation is matched anywhere in the message, like a quoted phrase. |

A bare word made only of letters and digits matches a whole word, which is what the search index answers fastest. To match part of a word, quote it: `"timeout"` also matches `timeouts`.

### Fields

| Query | Meaning |
| --- | --- |
| `level:error` | Error or worse (`error` and `fatal`). `level:warn` means warn or worse. |
| `level:=warn` | Exactly warn. |
| `service:api` | The project slug or service name. |
| `deployment:dep_8f2k1c` | One deployment. Also `build:`, `job:`, `node:`, `replica:`, `stream:`, `source:`. |
| `request:4b1c…` | Every line of one request: its edge record and app lines that logged the `X-Request-Id`. Also `trace:` and `span:`. |
| `@http.status:>=500` | An attribute, compared as a number. `>`, `>=`, `<` and `<=` work on numbers. |
| `@path:/api/*` | A wildcard: `*` matches anything. |
| `@msg:/time(out\|d out)/` | A regular expression, case-sensitive unless it starts with `(?i)`. Needs ClickHouse. |
| `@user.id:*` | The attribute is present. |
| `resource.host.name:edge-b` | A resource field, such as those an OpenTelemetry SDK sends. |
| `-@http.route:/health` | Exclude. `NOT` works too. |
| `a OR b`, `(a b) OR c` | Either side. `AND` is implied between terms; `AND`, `OR` and `NOT` are upper case. |

The built-in fields are `level`, `body` (also `message`), `service`, `scope`, `kind`, `project`, `deployment`, `build`, `job`, `node`, `replica`, `source`, `stream`, `channel` (`stdout`, `stderr` or `system`), `pattern`, `trace`, `span` and `request`. Field names are case-insensitive; attribute names are case-sensitive, exactly as your app logged them. The editor autocompletes fields, values and stages, and points at the exact place a query stops parsing.

### Pipe stages

Pipe stages turn matching lines into a table. They must come in this order, each at most once: `fields`, `dedup`, then `stats` or `patterns`, then `sort` and `limit`.

| Stage | What it does |
| --- | --- |
| `\| fields ts, level, @http.status, body` | Show only these columns. |
| `\| dedup body` | One line per distinct value, with a count. |
| `\| stats count() by bin(5m), level` | Aggregate. Functions: `count()`, `count_distinct(f)`, `sum`, `avg`, `min`, `max`, `p50`, `p90`, `p95`, `p99`. Group by up to four keys, one of which may be `bin()` (1 second to 1 day). Name a column with `as`. |
| `\| patterns` | Group lines by message template, most frequent first. |
| `\| sort p95 desc` | Sort by a column. |
| `\| limit 20` | At most this many rows (up to 10,000). |

Some useful queries:

```text
level:error | stats count() by bin(1m), service
source:access @http.status:>=500 | stats count() by @http.route | sort count desc | limit 10
source:access | stats p95(@duration_ms) as p95 by @http.route | sort p95 desc | limit 10
level:warn deployment:dep_8f2k1c | patterns
"payment failed" | dedup @order.id
```

## Modes

The tabs above the results show the same query in four ways.

- **Stream** lists matching lines, newest first, with infinite scroll in both directions. Severity sets the colour, terminal colours are rendered, and search terms are highlighted. Choose columns and line wrapping from the toolbar. Above it, a histogram stacks the lines by level, with markers for deploys and fired alerts; drag across it to zoom in.
- **Patterns** groups lines into templates, with the variable parts (numbers, ids, durations, paths) highlighted, a count, a sparkline and when the pattern was first seen. **Only this pattern** and **Hide this pattern** add `pattern:<id>` or `-pattern:<id>` to the query.
- **Analytics** runs `| stats` and draws a time series when you group by `bin()`, otherwise a table or bar chart. **Add to dashboard** turns it into a dashboard panel.
- **Compare** runs the query over a second window and lists patterns that are **new**, **rising**, **falling** or **gone**. The baseline can be the previous period, the same time yesterday or last week, a custom range, or the time before a deploy went live, which answers "what did this deploy change in my logs?". A deployment page links straight to it.

**Why?** explains a spike. Drag across a burst in the histogram and choose **Why?**: Yoal compares the selected lines with the rest of the window across the built-in fields and the most common attributes, and ranks what stands out, for example `node = edge-b` in 92% of the selection against 31% around it. Click a result to filter by it.

The **Fields** sidebar shows the top values of each field, with their share. Click a value to filter to it, or Alt-click to exclude it. Hidden facets are remembered for you only.

## Live tail

Turn on **Live** to stream new lines as they arrive, usually within two or three seconds. The tail uses the same query, and picks up right after the newest line already on screen, so nothing is missed or repeated. Scrolling away from the newest line, opening a line, or pressing `space` pauses it; a counter shows how many lines arrived meanwhile, and resuming adds them. If more lines arrive than the browser can keep up with, the tail skips some and says how many. A dropped connection reconnects and resumes where it left off.

A live tail on a build or pipeline job ends by itself when the build or job finishes.

## Line details and context

Open a line (click it, or `o`) to see every field, the attributes as JSON, and the raw line, with copy buttons and **Filter to this value** on each field. The links take you to the line's deployment, build, node or job, and to every line of the same request or trace. **Context** (`c`) shows the lines just before and after it in the same stream, like `grep -C`, with the line pinned.

Other pages link into the Explorer at the right moment: a 5xx spike on a traffic chart opens `source:access @http.status:>=500` for that window, an app error event opens the project's lines around it (and its request, when the error carried one), an alert opens the rule's query at the time it fired, and a node page opens that node's platform logs for platform admins.

## Saved queries, links and export

Everything about a view is in the page address: the query, scopes, time range, mode and the open line. Copy the URL to share an investigation.

**Save** stores the current query, scopes, time range and columns, either for you or for everyone in the organisation. Saved queries open from the palette (`⌘K`). You can edit and delete your own; owners and admins can also change the organisation's shared ones.

**Download** exports the current results as NDJSON or CSV, up to 100,000 lines. For more than that, or to keep logs longer, use a [log drain](/observe/dashboards-and-logs#log-drains).

### Keyboard

| Key | Action |
| --- | --- |
| `/` | Focus the query |
| `⌘↵` | Run the query |
| `j` / `k` | Next or previous line |
| `o` or `↵` | Open the line |
| `c` | Context around the line |
| `f` / `x` | Filter to, or exclude, the focused value |
| `space` | Pause or resume the live tail |
| `t` | Time picker |
| `[` / `]` | Previous or next time window |
| `⌘K` | Saved queries and scopes |
| `?` | Show the shortcuts |
| `esc` | Close the line or dialog |

## Alerts and dashboards from logs

**Create alert** in the Explorer toolbar turns the current query into an alert rule. Two kinds of log rule sit next to metric rules on the **Alerts** page:

- **Log count** fires when the number of matching lines in a window crosses a threshold, for example more than 50 `level:error` lines in 5 minutes. Group by a field to get one alert per value. It works without ClickHouse.
- **New log pattern** fires when a message pattern that was not seen in the scope during the lookback (7 days by default) appears at least N times. Limit it to the minutes after a deploy to catch errors a release introduced. It needs ClickHouse.

The templates **Error log lines** (`log_errors`) and **New error pattern after a deploy** (`log_new_pattern_after_deploy`) are a quick start. Notifications link to the Explorer with the rule's query and window filled in. See [alerts](/observe/alerts).

Dashboards have a **logs** dataset that counts lines (or distinct values of a field) grouped by level, source, scope, time or any attribute, and a **Logs** panel that shows a query's newest lines. Both only ever read what the viewer may read. See [dashboards](/observe/dashboards-and-logs#dashboards).

## Sending structured logs from your app

Plain output to stdout and stderr is always collected. For structured fields, either log one JSON object per line, or send OpenTelemetry logs.

**JSON lines.** A line such as `{"level":"error","msg":"payment failed","order":{"id":"o_123"},"request_id":"4b1c…"}` becomes an `error` record with the message `payment failed` and the attributes `@order.id` and `@request_id`. `level`, `severity` or `lvl` sets the severity; `trace_id`, `traceparent`, `request_id` and similar fields set the trace and request ids.

**OpenTelemetry.** Process, container and compose apps get these environment variables, unless you set them yourself:

| Variable | Value |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | The node's local OTLP receiver, with a key for this app in the path |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | The same, ending in `/v1/logs` |
| `OTEL_SERVICE_NAME` | The project slug |

Use your language's OpenTelemetry SDK with an OTLP/HTTP log exporter and **JSON encoding**: set `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json` where your SDK reads it. Protobuf is not accepted yet and gets a `415` answer. Records keep their severity, attributes, resource fields, and trace and span ids. Traces and metrics sent to the same endpoint are accepted and discarded, so an SDK that exports everything does not log errors.

The endpoint only accepts records for the app it was issued to, and Yoal decides the project from the app, never from resource attributes. If you already send OpenTelemetry to your own collector, your values win and nothing changes.

**Request ids.** The edge adds an `X-Request-Id` header to every request it forwards to your app (keeping one set by a trusted proxy in front) and returns it in the response. Log it as `request_id` and the Explorer joins your lines to the edge's record of the request with `request:<id>`.

## Retention, quotas and rules

Organisation owners and admins set these in **Settings → Logs**, for the organisation or for one project. Platform admins set the defaults.

| Setting | Default | Range |
| --- | --- | --- |
| Recent log store | 3 days with ClickHouse; without it, **Settings → Policies → Log retention** (7 days) | 1 to 14 days |
| Search index | 14 days | 1 to 90 days, per organisation and per project |
| Archive | Off | 30 to 400 days |
| Ingest rate per project | 1,000 lines/s, bursts of 20,000 | Lower only |
| Ingest per project per day | 5,120 MB | Lower only |
| Edge request sample (2xx and 3xx) | 10% | 0 to 100%; errors are always kept |

Each project or service also keeps at most 100,000 recent lines per log store, so one noisy app cannot push out another's history. Lines over a quota are dropped and counted, and a system line in the affected scope says how many were dropped and why. **Settings → Usage** shows log volume per project per day.

With the **archive** on, each day of indexed logs is also kept as compressed files in the platform's object storage. A search that reaches past the search window first shows how much archived data it would read and how long that might take, and reads it only when you confirm.

**Rules** change what is kept. Each rule is a log query and an action: **exclude** drops matching lines before they are stored, **sample** keeps a percentage of them, **index only** keeps them in the recent log store and drains but leaves them out of the search index, and **redact** masks text that matches a regular expression. Before you save one, **Preview** replays the last 15 minutes of logs through it and shows how many lines it would affect and which patterns they are.

## yoal logs, the API and agents

`yoal logs` uses the same query language and scopes from the terminal, and `-f` follows the live tail:

```sh
yoal logs api -q 'level:error' --since 1h
yoal logs api db:main -f
yoal logs -q '@http.status:>=500 | stats count() by bin(1m)' --since 6h
yoal logs compare api --baseline deploy:dep_8f2k1c
```

See [the CLI reference](/cli/deploying#logs) for every flag. The REST API is under `/api/v1/logs` (`search`, `table`, `histogram`, `fields`, `context`, `stream`, `compare`, `why`, `saved`, `rules` and `settings`); see [the REST API](/clients/rest-api). Agents use the read-only MCP tools `query_logs`, `get_log_patterns`, `get_log_context`, `compare_logs` and `explain_log_spike` ([MCP](/clients/mcp)), and the dashboard assistant can write a query for you, which it shows with a link to open in the Explorer rather than running it ([assistant](/clients/assistant)).
