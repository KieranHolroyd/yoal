# Yoal — v0 Spike Results (2026-11-03)

Environment: macOS arm64, Bun 1.4.0. RSS figures are from macOS and must be re-measured on Debian 13,
where they are typically lower.

> **Note (2026-11-06):** the release pin moved to Bun 1.4.4 for plan 22 (Bun.SQL `cancel()` and column metadata); the RSS figures below were measured on 1.4.0.

| # | Spike | Result | Where |
|---|---|---|---|
| 1 | DuckDB under Bun | ✅ Works | `spikes/duckdb` |
| 2 | Better Auth MCP/OAuth end to end | ✅ 15/15 e2e (dev and production build behind Caddy) | `apps/control-plane/tests/mcp-oauth.e2e.ts` |
| 3 | MCP human confirmation (elicitation) | ✅ Works for 2026-07-28 clients; 2025-era clients get a dashboard hand-off | same |
| 4 | Caddy admin API over a unix socket | ✅ 20/20 | `spikes/caddy` |
| 5 | SvelteKit 3 + adapter-bun + shadcn-svelte | ✅ Works, with several Kit 3 changes (below) | `apps/control-plane` |
| 6 | Litestream → R2 + restore | ⏳ Not run: needs R2 credentials | — |
| + | CIMD SSRF-safe transport under Bun | ✅ 8/8; DNS pinning honoured | `spikes/cimd-bun` |

## 1. DuckDB (`@duckdb/node-api` 2.0.0-r.1)
- Loads and runs under Bun with no workarounds.
- Speed:
  - 1M-row ingest via the Appender API: 1.1 s.
  - 1-minute rollup with p50/p95: 41 ms.
  - Parquet export (day-partitioned, zstd): 140 ms.
  - Query from Parquet: 2 ms.
- **Memory grows with the amount of hot data, and `memory_limit` doesn't cap RSS**:
  - About 140 MB at 600k rows (including Bun's ~35 MB baseline) with the limit set to 32, 64 or 256 MB.
  - It peaked at 320 MB during a 1M-row burst.
- **Design consequence:**
  - Agents must send **pre-aggregated 1-minute buckets**, never raw requests. 48 h for 20 sites is about 60k rows.
  - Raw access logs stay in Caddy's log files.
  - Run DuckDB in its own process or worker if it ever crowds the control plane.

## 2. Better Auth MCP / OAuth (better-auth 1.7.15)
- **The MCP 2026-07-28 spec deprecates Dynamic Client Registration in favour of Client ID Metadata Documents (CIMD).**
  - `@better-auth/mcp` `mcp()` *is* the OAuth 2.1 provider. Don't add `oauthProvider()` as well.
  - `@better-auth/cimd` adds CIMD.
  - Yoal enables **both**: CIMD by default, plus DCR via `YOAL_MCP_ALLOW_DCR` (default on) for older clients.
- CIMD needs an SSRF-safe fetch transport. The bundled `@better-auth/cimd/node` transport works under Bun:
  - It rejects loopback, private, link-local and metadata IPs, plain HTTP and redirects.
  - It **pins the DNS result**: Bun honours `node:https` `lookup`.
- OAuth scopes are exactly the RBAC permissions (`packages/contracts`).
  - A token's effective permissions are `scopes ∩ role`.
  - The consent screen pre-ticks deployer permissions and leaves destructive ones unticked.
- Access tokens are JWTs whose audience is `<origin>/mcp`, and refresh tokens are issued with `offline_access`.
- **Gotchas found:**
  - Root `/.well-known/*` discovery URLs have to be forwarded to `auth.handler`. The plugin answers the
    root protected-resource path itself.
  - **SvelteKit's built-in CSRF check blocks the OAuth token endpoint** in production builds (it's a
    cross-origin form POST by design). It's disabled (`csrf.trustedOrigins: ['*']`) and replaced with
    Yoal's stricter policy in `src/lib/server/csrf.ts`:
    - every mutation must be same-origin,
    - with an exact allowlist for cookieless endpoints (token, register, revoke, introspect, `/mcp`).
  - Better Auth logs "Expected string[] but got TEXT" warnings on SQLite when it re-checks the schema. They're harmless,
    because the arrays are stored as JSON text.
  - `requireMcpAuth` fetches JWKS over HTTP from `baseURL`, which means a self-call through Caddy in production.
    **Follow-up:** verify in-process, or point `jwksUrl` at the local socket.

## 3. MCP server (`@modelcontextprotocol/server` 2.4.0, protocol 2026-07-28)
- `createMcpHandler(factory)` is stateless per request and fits Yoal exactly.
- **Destructive confirmation** uses multi-round-trip input: `inputRequired(...)` + `acceptedContent(...)`.
  - The confirmation key embeds the project slug.
  - If the user declines, the tool cancels; it doesn't ask again.
- **2025-era clients** are served through the stateless legacy fallback. They can't receive input requests, so
  destructive tools return an error telling the agent to ask the user to act in the dashboard.
- **Scope step-up:** a per-tool `scopeChallenge` returns `403 insufficient_scope` with the full scope set, so
  the client re-runs OAuth and the user explicitly grants e.g. `project:delete`.
- Open question: which production clients (Claude Code, Claude.ai, Cursor) already speak 2026-07-28 and
  support form elicitation. That determines how often the dashboard hand-off appears.

## 4. Caddy 2.11.7 (+ `caddy-dns/cloudflare`)
- Admin API on a unix socket only. Nothing listens on TCP :2019.
- Route changes by `@id`:
  - insert: 2 ms
  - replace: 12 ms
  - delete: falls through to the catch-all 404
- Atomic **symlink swap** promotes and rolls back with no Caddy call.
- `file_server` `precompressed br gzip` works; cache and security headers work as designed.
- `forward_auth` to a Bun agent on a unix socket works. Forged cookies and cookies for another host are rejected.
- **Finding:** each admin call reloads the whole config. 300 sequential inserts took 4.9 s.
  → **The agent must apply all routes in one PUT per reconcile**, not one call per route.
- RSS: 66 MB with 301 routes.

## 5. SvelteKit 3.1.1 (stable since 2026-10-01) + `@sveltejs/adapter-bun` + shadcn-svelte 1.8.0
- Kit 3 changes that affected the code:
  - `$app/environment` → **`$app/env`**.
  - Hook types now come from **`@sveltejs/kit/hooks`**.
  - `$lib` → **`#lib`** (package.json subpath imports, which need explicit `.js` extensions).
  - Config lives in `vite.config.ts`.
  - `csrf.checkOrigin` was removed in favour of `csrf.trustedOrigins`.
- **Official `@sveltejs/adapter-bun`**:
  - It can listen on a **unix socket** (`SOCKET_PATH`), which is how Caddy will reach the control plane.
  - It defaults the request protocol to **https**; set `PROTOCOL_HEADER=x-forwarded-proto` and
    `HOST_HEADER=x-forwarded-host` behind Caddy.
  - Verified: the production build behind Caddy over a socket passes the full e2e.
- shadcn-svelte `nova` preset (Lucide + Geist, compact) initialises fine on Kit 3 / Tailwind 4.3.
- Server config is evaluated during build analysis, so `config.ts` skips validation while `building`.
- Control-plane RSS (production build, macOS): **92 MB idle, 145–163 MB after the e2e**.
  That's at or above the 80–150 MB target. Re-measure on Linux before optimising.

## 6. Email MTA under Bun 1.4.0 (E0, 2026-11-07, docs/EMAIL.md)

Libraries: `smtp-server` 3.21.3 (MIT-0), `nodemailer` 10.3.1 (MIT-0), `mailauth` 8.0.4 (MIT),
`mailparser` 3.14.2 (MIT).

- **Server-side STARTTLS works.** `smtp-server` upgrades the plain socket in place; nodemailer with
  `requireTLS` reported `session.secure = true` on all 201 messages. Implicit TLS (465) works too.
- **AUTH PLAIN** runs through `onAuth` after TLS, as it should.
- **DKIM:** `mailauth` `dkimSign` (RSA-2048, relaxed/relaxed) followed by `dkimVerify` with an
  injected resolver gives `pass`. `mailparser` parses the result and keeps the `DKIM-Signature`.
- **Throughput and memory:** 200 messages over a 4-connection TLS pool in 149 ms. RSS was 101 MB
  idle with every library loaded and 131 MB after the burst (macOS, `bun run`; re-measure on Linux).
- **Port 25 egress from the prod IP (Scaleway):** open. `gmail-smtp-in.l.google.com:25` answered
  `220 mx.google.com ESMTP`. Outbound 25 from a residential line (this Mac) times out, as expected.
- **PTR:** still the provider default `163-172-72-185.rev.poneytelecom.eu`. It has to become
  `mx1.<platformDomain>` in the Scaleway console before Gmail/Outlook delivery tests.
- Not yet run: a real delivery with DKIM/SPF/DMARC results at Gmail and Outlook (needs the PTR).

Verdict: build the MTA in Bun (D115). KumoMTA is no longer needed.

## 7. Still to do
- Litestream → R2 replication + `yoal restore` drill (needs an R2 bucket and credentials).
- Re-measure DuckDB, control-plane and Caddy RSS on Debian 13.
- Real-client check: connect Claude Code / Claude.ai to a deployed instance (CIMD vs DCR, protocol era).

## S2 — Litestream follow lag (2026-11-20)

Local half of CLUSTERING §15.2 S2 (HA-PLAN §4 W2). Rig: `spikes/s2-litestream-follow/` (`bun spikes/s2-litestream-follow/run.ts`; question, criteria and fallback in its README, committed first).

**Environment.** OrbStack 7.2.12 Linux VM (4 vCPU) on this Mac, arm64. Debian 13 containers (`oven/bun:1.4.4-slim`): one primary and one or two followers, each with its own data volume. Object store: local MinIO `RELEASE.2025-09-07T16-13-09Z`, not R2. Litestream **0.3.13** (Yoal's pin, `packages/contracts/src/platform-config.ts:35`) and **0.5.18** (upstream latest, 2026-11-03), both sha256-pinned and fetched at build time. Database: real `packages/db` migrations, 177 tables, 200k `audit_log` rows plus 200 generated rows in every other table, 123 MB. Writer: 50 tx/s with `createDb`'s pragmas; each transaction inserts an `audit_log` row and a heartbeat row, and every fifth updates `nodes`. Primary replicated by the unit's own `scripts/litestream.yml` (sync 1 s) unless stated. Lag = commit time of a heartbeat to its visibility for a read-only reader of the follower's file, polled every 50 ms. Writer and reader share one kernel clock.

**Follow modes.** 0.3.13 has none; only full `restore`. 0.5.9 added `litestream restore -f` (follow, default poll 1 s), and 0.5.10 added a `<db>-txid` file for crash recovery. Follow applies LTX files page by page under SQLite's own fcntl locks and rewrites the header to rollback mode. 0.5 also ships an experimental read-replica VFS (not tested). Everything below that follows uses 0.5.18. The pinned version cannot follow.

### Numbers

| Run | What | Result |
|---|---|---|
| Steady, unit config (sync 1 s, follow 1 s), 70 min, n = 209,760 | lag p50 / p95 / p99 / max | 0.94 / 1.40 / 2.67 / 13.7 s. After the first 2 min of warm-up: 0.93 / **1.38** / 1.42 / 3.4 s; 57% of rows ≤ 1 s |
| Same, second follower at follow 250 ms | lag after warm-up | 0.84 / 1.29 / 1.33 / 3.4 s. The 1 s primary sync dominates |
| Two further runs, unit config, 2 min each | lag | p50 1.5 s, p95 1.94–1.96 s. With two fixed 1 s tickers, the phase between primary sync and follower poll is fixed per process and moves lag by up to 1 s |
| Tuned: sync 250 ms, `monitor-interval` 250 ms, follow 250 ms, 15 min, n = 44,763 | lag | 0.45 / **0.73** / **0.78** / 0.87 s |
| Whole unit run including faults, n = 245,108 | lag | p95 6.95 s, p99 72.5 s (set by the cuts) |
| Promotion: quiesce, primary Litestream stopped, follower caught up in 1 ms, stop follow, open read-write in WAL mode | fingerprint, integrity | **Identical** `yoal-db-fingerprint.ts` output (245,675 heartbeats, 177 tables); `integrity_check` ok; 1.9 s to open and check |
| Promoted node replicates to the **same** replica path, 30 s of writes, fresh restore elsewhere | fingerprint | Identical (247,179). Litestream logs `detected database behind replica db_txid=0` and adopts the replica's TXID without checking the file |
| `kill -9` of the whole primary container during writes (tuned config) | RPO, integrity | 5 rows / 100 ms lost (smoke run: 11 rows / 218 ms). Follower integrity ok and byte-identical to a fresh restore of the replica |
| 60 s follower cut (network disconnect), unguarded | time from reconnect to lag < 1 s | **47.1 s** (max lag 107 s), second sample 9.95 s. No error is logged: an in-flight S3 request on the dead connection resumes only on the next TCP retransmission (backoff ≈ 51 s, then 102 s). Litestream sets no request timeout |
| 60 s primary cut, unguarded | recovery | 26.8 s and 2.4 s (same mechanism) |
| 60 s follower cut with a no-progress watchdog (prototype in the rig: no `-txid` change for 10 s → `kill -9` and restart) | recovery | **4.3 s** |
| 60 s store freeze (MinIO paused, silent) | recovery | 1.4 s |
| Follower `kill -9` and restart; container kill and start | position kept, recovery | Resumed from `-txid` both times, no full restore; 1.1 s and 9.0 s |
| Follower down 7 min (longer than the 5 min L0 retention) | catch-up | Resumed from `-txid`, bridged the gap from L1 and up, caught up in 4.2 s |
| Initial follow restore of the 123 MB DB / plain `restore` (0.5.18) | time | 3.0 s / 1.85 s (local MinIO) |
| Fallback, 0.3.13 unit config: restore to staging every 60 s, `mv`, `sync` | restore, swap, data age at swap | Restore 186, 418, 681, 875, 1153 ms (grows about 240 ms/min with WAL since the day's only snapshot); swap 23–74 ms; age 0.8–1.9 s; quick_check ok |
| 0.5.18 against a 0.3.13 replica | restore / follow | Restore ok (2.2 s); follow fails: `no matching backup files available` |
| Resources, 70 min steady | RSS, CPU | `replicate` 32 MB, 1.4% of a core; `restore -f` 24 MB and 1.1% at 1 s, 26 MB and 5.1% at 250 ms |

**Store requests (MinIO metrics; R2 list price Class A $4.50/M, Class B $0.36/M, to be checked).** Primary writing at sync 1 s: about 1.5 PUT/s plus multipart (≈ $20–35 a month). At sync 250 ms: 4.6 PUT/s. A follower at 1 s while writes flow: about 0.7 LIST + 1.4 GET/s (≈ $9 a month). **An idle follower: 9.05 LIST/s at 1 s and 36 LIST/s at 250 ms**, because an empty L0 poll falls through to `fillFollowGap`, which lists levels 1–8 on every poll. On R2 that is about $104 and $420 a month per standby while the control plane is quiet.

### Further findings

1. **A reader can stall follow indefinitely.** A restored file keeps the primary's WAL header until the first apply rewrites it. A read-only connection opened in that window holds a SHARED lock for as long as it stays open, and follow waits on `F_SETLKW` for an exclusive lock. Reproduced by the `walstall` scenario: txid stuck at 8 for 28 s, resumed as soon as the reader closed. The standby must not open the file until byte 18 of the header is 1, and readers need `busy_timeout`: 6 `SQLITE_BUSY` in 70 min, all in warm-up.
2. **0.5 silently ignores the unit's per-replica `snapshot-interval` and `retention`.** The file loads without warning and snapshot retention becomes 0.5's 24 h default, not 720 h. The restore window, the drill and CLUSTERING §6.2's "720 h" all change. Upgrading the pin needs a config rewrite (`snapshot:`, singular `replica:`) and a new replica lineage, because 0.5 cannot follow a v3 replica.
3. **0.5 release asset names changed** (`litestream-0.5.18-linux-x86_64.tar.gz`, no `v`), so `litestreamAsset()` in `scripts/platform-config/helper.ts` would build a wrong URL.
4. **Promotion must check replay.** Litestream on a promoted node trusts the replica's TXID ("database behind replica"), so promoting a follower that has not applied the replica's latest TXID would put two histories in one chain. Not tested in the unsafe direction. §6.1's `promoting` state must compare the `-txid` file with the replica's max TXID, and the old primary must be fenced first.
5. A transient full disk on the shared host paused one primary sync ("replication paused until space is freed"); it recovered within 1 s.

### Per criterion

| Criterion | Result |
|---|---|
| p95 ≤ 1 s | **FAIL** with the unit config (1.38–1.96 s); **PASS** tuned (0.73 s, 15 min only) |
| p99 ≤ 5 s | PASS steady in both configurations (1.42 s; 0.78 s). Whole run with faults: 72.5 s |
| Promotion: identical fingerprint, integrity ok | **PASS** (quiesced and after `kill -9`; also after the promoted node took over the replica path) |
| Recovery after a 60 s cut ≤ 30 s | **FAIL** unguarded (47.1 s in 1 of 4 samples; bounded by TCP backoff, not by Litestream); PASS with the watchdog (4.3 s, one sample) |
| A restart keeps the replay position | **PASS** (process `kill -9`, container restart, 7-minute outage) |

**Verdict: conditional pass. Build C6/W9 on `litestream restore -f`; the restore-and-swap fallback is not triggered.** Conditions:
1. Move the pin to Litestream ≥ 0.5.9 (0.5.18 tested): rewrite the config, start a new replica lineage, and fix the asset URL.
2. Shorten primary sync and monitor intervals and the follow interval to about 250 ms. This costs about 3× the PUTs.
3. A no-progress watchdog on the follower that compares with the replica's max TXID, or an upstream request timeout.
4. Rule 1 for readers.
5. A replay check before promotion.
6. A fix for the idle-poll LIST multiplication before R2: an adaptive poll or an upstream change. Otherwise each standby costs about $100 a month at idle.

If the pin stays at 0.3.13, the fallback applies. Its restore time grows through each snapshot day, so it also needs a snapshot interval far shorter than 24 h. The 24 h soak and the R2 half (WAN latency, R2 list behaviour, real cost) are still owed before C6's criteria can be called met.

**Not tested:** 24 h duration; R2; amd64 and the unit's systemd sandboxing; real power loss (`docker kill` keeps the page cache); promotion from a follower that is behind; two primaries on one replica path; a standby offline beyond snapshot retention; the VFS read replica; the real control-plane process as writer or reader.

### S2 (R2), 2026-11-20

The same rig against Cloudflare R2 (`S2_TARGET=r2`), from this Mac over a residential uplink, so not from the production region.

**Method.** Every object sat under one run prefix (`yoal-w0-spikes/s2-<run-id>/`). The unit's config was used with only the replica `path` moved under that prefix. Containers reached R2 through `proxy.ts`, a counting pass-through on the rig network. It forwards each signed request unchanged to `https://<r2-host>` and records operation, status and latency, never URLs or headers. Runs:
- `unit`: sync 1 s, follow 1 s, 12 min steady, one 60 s follower cut, follower `kill -9`, promotion.
- `tuned`: 250 ms intervals, 12 min steady, then primary `kill -9`.
- `idle`: request rates in 60 s windows.
- A 1-minute smoke run before these.

At the end every object under the prefix was deleted: 2,113 + 320 objects, and a list of the prefix returned 0.

| Measure | R2 | MinIO (above) |
|---|---|---|
| Steady lag, unit config, 12 min, n = 35,769 | p50 1.67 s, **p95 2.17 s**, p99 2.33 s, max 2.96 s; after warm-up 1.69 / 2.18 / 2.34 s; 0.02% of rows ≤ 1 s; every minute p95 2.0–2.24 s | p95 1.38 s |
| Steady lag, 250 ms, 12 min, n = 35,765 | **Drifts upward**: per-minute p50 2.8 → 9.3 s; overall p95 9.56 s, p99 10.4 s | p95 0.73 s |
| Why 250 ms fails on R2 | Each L0 file costs one PUT on the primary (p50 210 ms) and one sequential GET on the follower (p50 112 ms) plus a LIST per poll. At about 4.8 files/s both loops are saturated: the follower applied about 4.9 files/s against 4.8 produced | — |
| Primary `kill -9` (250 ms) | 336 rows / **6.7 s** lost; the follower equals a fresh restore, so the replica itself was 6.7 s behind (upload backlog) | 5 rows / 100 ms |
| Promotion (unit config) | Fingerprint **identical**, `integrity_check` ok (48,754 heartbeats). After the promoted node took over the path, a fresh restore was identical (50,260) | Same |
| 60 s follower cut | First apply 47.4 s after reconnect (same TCP-backoff stall), then 32 s to work through the backlog one GET per file. Back under steady p95 (2.2 s) **80 s** after reconnect; max lag 109 s | 47.1 s / 9.95 s |
| Follower `kill -9` and restart | Resumed from `-txid`; back to steady in 5.1–5.5 s | 1.1 s |
| Initial snapshot (123 MB DB, 66 MB compressed) / initial follow restore / plain restore | 13.4 s / 3.3 s / 8.2 s | 4.1 / 3.0 / 1.85 s |
| Latency per operation (proxy, n) | PutObject p50 210 / p95 273 ms (5,257); GetObject 112 / 198 ms (5,382); ListObjects 138 / 442 ms (4,020); UploadPart 874 / 3,273 ms (187) | — |
| Throttling | **429 on ListObjects only: 70 of 4,020 (1.7%)**, plus 3 of 298 in the smoke run; none on PUT or GET. The SDK retries them silently; Litestream logged no warning or error | None |
| Consistency | No missing or not-yet-visible LTX file in any follower log (0 WARN/ERROR lines in 10 Litestream logs); every fingerprint matched | Same |
| Idle follower LIST rate | 9.1/s at 1 s (same as MinIO); **10.9/s at 250 ms** (MinIO 36/s): each poll lists 9 levels at R2 latency, so polls cannot run faster than about 1/s | 9.05 / 36 |
| Rates while writing | Primary alone: 1.37 PUT + 0.22 LIST + multipart about 0.26/s. Adding a 1 s follower: +2.1 LIST/s and +1.35 GET/s | — |

**Operations and cost of this spike (measured).** 10,320 Class A over both runs and 5,804 Class B (GET). The main run's Class A was 9,680: LIST 4,020 + 75 from the rig host, PUT 5,257, multipart 215, and DeleteObjects 113, priced as Class A to be safe. The smoke run added 638. At list prices ($4.50/M Class A, $0.36/M Class B) that is **about $0.049**. Single deletes are free (2,433), and storage was under 100 MB for under an hour.

**Steady-state cost per month at these rates (30 days).**
- Primary at sync 1 s, writing: about 1.85 Class A/s, about $22.
- One 1 s follower while writes flow: about 2.1 LIST + 1.35 GET/s, about $26.
- An idle 1 s follower: 9.1 LIST/s, about **$106 per standby**.
- At 250 ms: the primary's PUTs about 3×, and the follower about 11 LIST/s when idle.

### Per criterion on R2

| Criterion | Result |
|---|---|
| p95 ≤ 1 s | **FAIL** (2.17 s at 1 s; 9.56 s and rising at 250 ms) |
| p99 ≤ 5 s | **PASS** at 1 s (2.33 s); **FAIL** at 250 ms (10.4 s) |
| Promotion fingerprint and integrity | **PASS** |
| Recovery after a 60 s cut ≤ 30 s | **FAIL** (80 s, unguarded). The watchdog was not run on R2 (one cut in budget). Estimate with it: 10 s to detect plus about 15 s to fetch about 70 s of backlog at about 5 files/s; not measured |
| A restart keeps the replay position | **PASS** |

**What R2 changes in the verdict.**
- Follow over R2 is continuous and correct: it applied every file in order, and promotion was byte-identical. But **it cannot meet p95 ≤ 1 s with Litestream 0.5.18 from here.**
  - At the unit's 1 s it settles at p95 about 2.2 s and p99 about 2.3 s.
  - Shorter intervals make it worse, because follow fetches one object per L0 file sequentially and the primary uploads one per sync.
  - So condition 2 of the MinIO verdict (250 ms intervals) **does not transfer to R2**. Keep sync and follow at 1 s on R2.
- C6's ≤ 1 s control-plane RPO and lag target needs one of:
  - a human decision to set the R2 bound at about p95 2.5 s / p99 5 s (I have not loosened the criterion);
  - an upstream change that batches or parallelises follow GETs;
  - a different transport.
- The restore-and-swap fallback is worse on every axis (RPO 60 s), so follow is still the branch to build.
- The cut criterion needs the watchdog, and on R2 also a faster catch-up path; measure both before C6.
- Not run: the 24 h soak; a run from the production region (Scaleway Paris); the watchdog on R2; intervals between 250 ms and 1 s (500 ms might sit between the two results).
