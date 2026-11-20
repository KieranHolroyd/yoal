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

## S3 — Conditional writes as the only arbiter: local stores (2026-11-20)

Question, criteria and fallback: [`spikes/s3-cas/README.md`](../spikes/s3-cas/README.md) (CLUSTERING §15.2 S3,
§6.3; HA-PLAN W2). Rig: `bun spikes/s3-cas/run-local.ts` (one command; starts and removes the containers).
R2, AWS S3, Azure Blob and GCS are not in this run; the same rig takes any S3 target from `S3_*`
variables, and Azure/GCS are one `CasTarget` adapter each (S7).

**Environment.** Apple M3 Pro, macOS 27.3, Bun 1.4.5, OrbStack Docker 29.8.2, shared with other lanes
(load average 5–7 during the runs). One single-node container per store on a random loopback port, data on an
anonymous volume, run one store at a time. The client is the production `S3ObjectStore`; the lease is the
unchanged `ControlLease` (`packages/core/src/ha-lease.ts`).

| Store | Version | Image |
|---|---|---|
| MinIO | `RELEASE.2025-10-15T17-29-55Z`, commit `9e49d5e7`, go1.24.8 | Built from the archived source tag by `spikes/s3-cas/stores/minio.Dockerfile` (no public image or binary remains: quay and Docker Hub refuse the pull, dl.min.io answers 410). Reports itself as `DEVELOPMENT.2025-10-15T17-29-55Z` |
| Garage | v2.5.0 | `dxflrs/garage@sha256:677e5b758e4425a325b811c425c026bf35a4bf42f7ddbaa773de3f4fd779a5a5`, `replication_factor = 1`, lmdb |
| RustFS | 1.0.6 | `rustfs/rustfs@sha256:ee717072290bec9b11abfc0365f8310b00df1cd9b3639943edae47bdef05044a`, single drive |

**Method.** Per store: 20 `Date` readings against the Mac clock corrected by `sntp time.apple.com`
(±21 ms); a table of single-key conditions; 50 identical-body writes; stale and ABA (X→Y→X) `If-Match`;
an unconditional PUT under a held `If-Match`; 200 sequential write→GET→HEAD rounds; **10,000 CAS attempts by
200 writers in 50 lock-step rounds over 60 s** (every 200 checked as a link in one ETag chain from the first
object, winners re-read with GET and HEAD); a further 15 s free-running flood at 200 writers; a TCP proxy that
holds one request or one response for 5 s against a client with a 2 s deadline (four cases); then 240 s of
`ControlLease` with three contenders (policy scaled ÷5: TTL 6 s, fence 4 s, takeover 8 s), the primary frozen
for 12 s every 15 s, one contender behind the proxy with 22–28 random holds of 1–3.5 s, and a final targeted
case: a renewal answered 6 s late, then the primary frozen. MinIO and RustFS contention was run twice.

**Response codes.**

| Condition on PUT | MinIO | Garage | RustFS |
|---|---|---|---|
| `If-None-Match: *`, key absent | 200 | 200 | 200 |
| `If-None-Match: *`, key exists | 412 PreconditionFailed | **200** | 412 PreconditionFailed |
| `If-Match` current ETag | 200 | 200 | 200 |
| `If-Match` stale ETag (other body) | 412 | **200** | 412 |
| `If-Match` unknown ETag | 412 | **200** | 412 |
| `If-Match` on an absent key | 404 NoSuchKey | **200** | 404 NoSuchKey |
| `If-Match` stale, body since restored (ABA) | **200** | **200** | **200** |
| `If-Match: W/<current>` | 412 | 200 | 412 |
| `If-Match: *`, key exists | 200 | 200 | 200 |
| `If-Match` + `If-None-Match: *` | 412 | 200 | 412 |
| `If-None-Match: <current ETag>` (not defined for S3 PUT) | 412 (implements RFC 9110) | **200, object replaced** | 501 NotImplemented |
| `If-None-Match: <other ETag>` | 200 | 200 | 501 NotImplemented |
| Holder's `If-Match` after an unconditional PUT | 412 | **200** | 412 |
| Retry of an applied `If-Match` after a client timeout | 412 | **200** | 412 |
| Under 200-writer load, besides 200/412 | 14 and 24 ECONNRESET | — | 503 (4 and 54), GET 503 (22 and 1) |

**Numbers per criterion** (two contention runs shown as run 1 / run 2).

| Criterion | MinIO | Garage | RustFS |
|---|---|---|---|
| Exactly one 200 per epoch, never two holders | **PASS** — 351 / 251 wins, 1,338 in the flood; every 200 one link of the chain; 0 ETags consumed twice | **FAIL** — 10,000 of 10,000 attempts got 200 across 146 epochs; 144 epochs with two or more 200s | **PASS** — 24 / 25 wins, 7 in the flood; chain intact |
| 409/412, never 200, for a stale `If-Match` | **PASS** for a stale ETag; **FAIL** in the ABA form (200) | **FAIL** (200 for stale, unknown and absent) | **PASS** for a stale ETag; **FAIL** in the ABA form (200) |
| The ETag changes on every write | **FAIL** — 50 identical-body writes, 1 ETag (content MD5) | **FAIL** — same | **FAIL** — same |
| p99 PUT ≤ 300 ms (200 writers) | **FAIL** — p50 104 / 124 ms, p99 371 / 372 ms, max 1.1 / 3.6 s (sequential p99 16 ms) | PASS — p99 208 ms (meaningless: nothing is compared) | **FAIL** — p50 52 / 48 ms, p99 4,013 / 4,381 ms, max 5.0 s; the 60 s schedule took 89 s; flood managed 819 attempts in 15 s (sequential p99 9 ms) |
| Store time within 5 s of true time | **PASS** — −1,004 to −24 ms | **PASS** — −912 to −33 ms | **PASS** — −886 to −10 ms |
| 501 for an unsupported condition, never silent success | **PASS** — no silent success (MinIO evaluates `If-None-Match: <etag>`) | **FAIL** — every condition ignored with 200 | **PASS** — 501 |
| T1 `If-None-Match: *` on existing key refused | PASS | **FAIL** | PASS |
| T2 unconditional PUT breaks a held `If-Match` | PASS | **FAIL** | PASS |
| T3 read-after-write (GET and HEAD, 200 sequential + every winner) | PASS — 0 stale | PASS sequentially; under contention n/a | PASS — 0 stale |
| T4 held request/response (5 s, client deadline 2 s) | **PASS** — applied-then-timed-out retry 412; late stale write lost to the competitor; late copy lost to the retry; waited 200 after 5.0 s matched a read | **FAIL** — the retry got a second 200; the late stale write replaced the competitor's and the retry's | **PASS** — as MinIO |
| T5 `ControlLease`, 3 contenders, 240 s | **PASS** — 15 terms, 12 freezes, 24 holds, 14 fences, 0 overlaps, epochs 1→15 | **FAIL** — 1 overlap (683 ms) with two primaries at epoch 2 | **PASS** — 14 terms, 12 freezes, 28 holds, 13 fences, 0 overlaps, epochs 1→14 |

**Verdict.** By the criteria as written, **all three fail**, so none is offered as an arbiter (HA-PLAN W2
fallback: per store, not offered; installs on a local store get no automatic promotion, CLUSTERING §15.4 S3).
The failures are of two different kinds:

- **Garage v2.5.0 has no conditional PUT and says so nowhere.** It ignores `If-Match` and `If-None-Match`
  and answers 200, so the real `ControlLease` produced two primaries at one epoch. Hard fail.
- **MinIO and RustFS are correct compare-and-swap stores** — one winner per ETag across 20,000+ contended
  attempts, stale and late writes refused, no stale reads, no lease overlap under chaos — and fail on
  (a) the ETag criterion, because their ETag is the body's MD5, and (b) p99 at 200 writers on this shared
  laptop. RustFS also serialises badly under contention (503s, 4–5 s tails, schedule overrun).

**Fallback triggered.** Per store, not offered as an arbiter (MinIO, Garage, RustFS). Not a global fail:
R2/S3/Azure/GCS are still to run.

**What this proves wrong in the plan.**

1. *"The ETag changes on every write"* is not a store property of any MD5-ETag store. AWS S3 and R2 also use
   the MD5 for single-part uploads without SSE-KMS, so they will most likely fail it too (not tested).
   Proposal: make it a client guarantee. Every lease body carries a per-write nonce or counter, so no two
   writes are byte-identical and the ABA case cannot arise. Then judge stores on stale/ABA refusal for
   lease-shaped bodies. Today's `ControlLease` bodies differ in practice (`expiresAt` moves with each
   renewal), but nothing guarantees it: two renewals in one store second, or a store clock stepping back,
   repeat a body.
2. *"A 501 … means the store has no conditional PUT"* (§6.3) does not catch the store that actually lacks
   it: Garage answers 200. Enabling HA must run an active conformance probe first (create-only on an existing
   key → 412; stale `If-Match` → 412; unconditional PUT then the holder's `If-Match` → 412), which is the
   first half of this rig. It must refuse the store otherwise.
3. **`ControlLease` can overlap two holders when a write's answer is late (client bug, all stores).**
   `#lastConfirmedAt` is taken when the response *arrives*, so a renewal answered *d* late lets `holds()`
   run until apply + *d* + fence. A standby that watched the ETag from apply takes over at apply + takeover.
   Overlap whenever *d* > takeover − fence (20 s at the default policy). Reproduced on every store at the
   scaled policy: 1,450 ms (MinIO), 1,211 ms (Garage), 1,696 ms (RustFS) of two contenders passing
   `holds()`. Fix (not applied; production code untouched): record the monotonic time *before* sending the
   write and use that as the confirmation time; also give `S3ObjectStore` a request deadline below
   `fenceAfterMs`, since it has none today.
4. p99 ≤ 300 ms at 200 writers measures a load about 1,000× the lease's (three writers every 5 s; sequential
   p99 was 9–16 ms everywhere). The criterion stands as written here. Whether it should gate a lease store is
   for the plan owner to decide.

**Not tested.**

- R2, AWS S3, Azure, GCS (need credentials).
- Multi-node and erasure-coded deployments, which could change the answer. MinIO and RustFS check the
  condition under a distributed namespace lock; behaviour under partition or lock loss is unknown. Garage
  has no conditional write to test, and its quorum/CRDT design offers no linearizable CAS (from its design,
  not verified here).
- Clock drift independent of the host: the containers share the OrbStack VM clock, which follows the Mac, so
  the clock check proves only that the `Date` header is honest.
- Latency on dedicated hardware, without OrbStack port forwarding and other lanes' load.
- RustFS's 503 error code (the production client drops the body).
- The fetch-layer variant of T4 for TLS endpoints, written for R2/S3 but not exercised here.

## S3 (R2) and S7 (GCS): conditional writes on real stores (2026-11-20)

Question, criteria and fallback: [`spikes/s3-cas/README.md`](../spikes/s3-cas/README.md). For R2, the S3 section
is unchanged. For GCS, the S7 section was committed before any GCS code. Rig: `bun spikes/s3-cas/run-cloud.ts`
(one command; credentials from the environment only; output scrubbed). Every object lived under
`yoal-w0-spikes/<run-id>/`. Each run deleted its prefix, and a fresh LIST of every prefix used (4 runs + 2
debug probes) returned 0 objects in both buckets.

**Environment.** Apple M3 Pro, macOS 27.3, Bun 1.4.5. The client is this Mac on a home broadband line, so
latency includes the WAN round trip. **R2**: one bucket, automatic location, through the production
`S3ObjectStore` (SigV4, region `auto`, path style). **GCS**: one bucket through the JSON API v1, with a
service-account OAuth token (RS256 JWT, `node:crypto`). Bucket location and class were not read. The
GCS adapter (`spikes/s3-cas/gcs.ts`) maps `If-Match` → `ifGenerationMatch=<generation>` and
`If-None-Match: *` → `ifGenerationMatch=0`. The CAS token is the generation. Clock reference: `sntp
time.apple.com` (±21 ms).

**Method.** This is the local run's method, unchanged: 20 `Date` readings; the single-key condition table;
50 identical-body writes; stale and ABA `If-Match`; an unconditional PUT under a held condition; 200
sequential write→GET→HEAD rounds; **10,000 CAS attempts by 200 writers in 50 rounds over 60 s**; a 200-writer
flood (capped at 2,000 attempts to limit cost); and T4 at the fetch layer, since both stores are TLS-only.
On R2 only, the unchanged `ControlLease` ran for 240 s with 3 contenders. Additions:

- A lease-sized body check (T6, see Deviations).
- An R2 conflict probe: 10 bursts of 20 simultaneous `If-Match` writes on one ETag.
- Renewal-rate probes on one key: 24 writes at 5 s intervals, 60 at 1 s, and 30 back to back.

About 15,000 writes per store over all runs.

**Response codes.**

| Condition | R2 | GCS (translated) |
|---|---|---|
| Create-only, key absent | 200 | 200 |
| Create-only, key exists | 412 PreconditionFailed | 412 conditionNotMet |
| Match current | 200 | 200 |
| Match stale / unknown token | 412 / 412 | 412 / 412 |
| Match on an absent key | 412 (MinIO/RustFS: 404) | 412 |
| Match stale, body since restored (ABA) | **200** | 412 |
| `W/` token (GCS: `ifGenerationMatch=W/<g>`) | 412 | 400 invalidParameter |
| `If-Match: *` (GCS: `ifGenerationNotMatch=0`) on existing | 200 | 200 |
| Match + create-only (GCS: `ifGenerationMatch=g&ifGenerationNotMatch=g`) | 412 | 304 (not applied) |
| `If-None-Match: <current ETag>` header on PUT/upload | 412 (evaluated, like MinIO) | **200, object replaced** (the JSON API ignores the header) |
| Holder's condition after an unconditional write | 412 | 412 |
| Retry of an applied conditional write after a client timeout | 412 | 412 |
| Losers under 200-writer contention | 412 only: 9,875 + 1,988 + 190 in the probe; **never 409** | 412 (2,604 + 825) and **429** (7,303 + 1,167); no 503 |
| GET/HEAD token of a 109-byte JSON lease body | **`W/"<md5>"`** (gzip at the edge); `If-Match` with it → **412** | the generation; `ifGenerationMatch` with it → 200 |

**Numbers per criterion.**

| Criterion | R2 (S3 criteria) | GCS (S7 criteria) |
|---|---|---|
| Exactly one winner per epoch/generation, 200 writers | **PASS**: 125 wins in 10,000 attempts and 12 in the 2,000-attempt flood. Every 200 is one link of the chain, and 0 tokens were consumed twice. Conflict probe: exactly 1 winner in each of 10 bursts of 20 | **PASS**: 93 wins in 10,000 attempts and 8 in 2,000. Chain intact; 0 doubles |
| Stale condition refused | **PASS** for stale, unknown and absent (412); **FAIL** in the ABA form (200) | **PASS**: 412 for stale, unknown, absent, create-on-existing and ABA |
| Token changes on every write (no ABA) | **FAIL**: 50 identical-body writes, 1 ETag. The ETag **is the body's MD5** (`"11e1a16f…"` = MD5 of `{"epoch":1}`) | **PASS**: 50 identical-body writes, 51 distinct generations |
| Store clock within 5 s | **PASS**: −894 to +31 ms | **PASS**: −962 to −6 ms |
| p99 at 200 writers | **PASS** (≤ 300 ms): p50 196 ms, p99 282 ms, max 571 ms | Reported: p50 69 ms, p99 251 ms, max 1,574 ms |
| p99 sequential (reported) | p50 226 ms, p99 318 ms (WAN) | p50 164 ms, p99 247 ms (241 PUTs, 41 of them 429) |
| Throttling (S7.5; recorded for R2) | None: 0 × 429/503 in any phase. Renewals 24/24 at 5 s, 60/60 at 1 s, 30/30 back to back (4.6 writes/s on one key) | **429 is the main loser answer under contention** (73% of rounds attempts). It is also returned to a lone writer above ~1 write/s per object: 14 of 50 identical-body writes, 41 in the sequential phase, 1 of 60 renewals at 1 s, 5 of 30 back to back, 0 of 24 at 5 s. **0 throttled writes applied** (chain intact; every re-read after a 429 showed the old generation) |
| Unsupported condition, never silent success | **PASS** (412, object unchanged) | Recorded, not gating: the S3-dialect header is ignored (200, replaced). The malformed generation condition is refused with 400: **PASS** |
| T1 create-only on an existing key | PASS | PASS |
| T2 unconditional write breaks a held condition | PASS | PASS |
| T3 read-after-write (200 sequential + every winner) | PASS: 0 stale | PASS: 0 stale |
| T4 held request/response (fetch layer, 5 s, deadline 2 s) | **PASS**: applied-then-timed-out retry 412; late stale write lost to the competitor; late copy lost to the retry | **PASS**: same three cases |
| T5 `ControlLease`, 3 contenders, 240 s (R2 only) | **FAIL as shipped**: node-a fenced on its first renewal ("lost the compare-and-swap"); 0 takeovers in 240 s; epochs 1→1. **PASS with the rig's identity-read fix**: 13 terms, 12 freezes, 27 held requests/responses, 12 fences, 0 overlaps, epochs 1→13 | Not run (brief: R2 only) |
| T6 the GET token of a lease-sized body satisfies `If-Match` (new) | **FAIL** as shipped; **PASS** with `Accept-Encoding: identity` | PASS |
| `client-late-confirm` (client bug from the local run) | Reproduced: 1 overlap of 130 ms | — |

**Verdict.**

- **GCS: PASS** on every S7 criterion and every tightening. Generation preconditions are a sound sole
  arbiter: generations never repeat, so there is no ABA. Throttling answers 429 and never applies the write.
  It can be **offered as an arbiter once a GCS `ConditionalStore` exists** (the rig's `gcs.ts` is the
  prototype; production has none).
- **R2: FAIL** as an arbiter with today's client, on two counts:
  1. *ETag = MD5 of the body*: the ABA case returns 200. This is the local stores' failure.
  2. **New, and fatal for the shipped lease**: Cloudflare's edge gzips `application/json` and `text/*` bodies
     of ≥ ~50 bytes when the client accepts gzip, which Bun's `fetch` does by default. It then returns
     `ETag: W/"…"` on GET and HEAD. RFC 9110 `If-Match` uses strong comparison, so every renewal and takeover
     loses with 412. Under 50 bytes, and for `application/octet-stream`, the ETag stays strong. That is why
     the contention phases (≈30-byte bodies) passed and the lease did not.

  As a CAS engine R2 is correct: one winner per ETag across 12,200 contended writes, every loser 412, no stale
  reads, late writes refused. With both client fixes below, it would fail only the "ETag changes on every
  write" criterion as a store property.

**Fallback triggered.** Per HA-PLAN W2, R2 is not offered as an arbiter until the client fixes land and
this rig passes on R2 (re-run `STORES=r2-identity` after the fixes). GCS is not offered until a production
GCS adapter exists, then gated by the conformance probe. Installs on either get no automatic promotion
until then (CLUSTERING §15.4 S3: fail closed).

**What this proves wrong in the plan.**

1. CLUSTERING §6.3: *"S3 and R2 return `409 ConditionalRequestConflict` when two conditional writes race"* is
   wrong for R2 as observed: 0 × 409 in 12,200 contended writes, and every loser got `412 PreconditionFailed`.
   Keep handling 409 (AWS may send it), but nothing should depend on seeing it.
2. §6.3 treats the ETag as opaque and usable as read. On R2 the read ETag is weak for any real lease body.
   The lease must read with `Accept-Encoding: identity` (an unsigned header; SigV4 is unaffected). It must
   also treat a `W/` token as "store unusable: fail closed with a clear reason", not as a lost CAS. Two
   alternatives: write the lease as `application/octet-stream`, or strip `W/`. Stripping is unsafe for a
   general store.
3. *"The token changes on every write"* holds for GCS (generation) and fails for R2 (MD5), as predicted from
   the local run. AWS S3 is still untested.
4. GCS answers **429 to a lone writer above ~1 write/s per object**. That is harmless at the 5 s production
   renew interval (0/24). `ControlLease` treats 429 as "unreachable", which is correct, and only fences after
   `fenceAfterMs`. A 1 s renew cadence would see sporadic 429s (1/60).

**Recommendation on the local run's proposed client fix.** Adopt both parts, and add a third:

- **A per-write counter in the lease body, not a random nonce**: `seq = read.seq + 1` on every write
  (renewal, takeover, release). Each successful write is CAS'd against the previous object, so `seq` strictly
  increases along the chain. No later body can equal an earlier one, and an MD5-ETag store (R2, MinIO,
  RustFS) can no longer be fooled by ABA. Unlike a nonce, it is deterministic and shows write order when
  debugging. GCS does not need it, but it is harmless there.
- **An active conformance probe before HA is enabled, not reliance on 501.** 501 is no signal: GCS ignores
  unknown conditional headers with 200, and Garage ignores all of them. The probe runs about 10 requests
  under a scratch key in the lease bucket:
  - create-only on an existing key → 409/412;
  - a stale condition → 409/412;
  - an unconditional write, then the holder's condition → 409/412;
  - **the GET token of a lease-sized body satisfies the condition** (catches R2's weak ETag);
  - for MD5 stores, an ABA probe *with `seq` bodies* is moot; record whether the token is the body MD5, for
    information only.

  The probe refuses the store on any failure, and the setup surfaces the reason.
- **Identity reads plus weak-ETag rejection**, as in point 2 above, and the T5 overlap fix from the local
  run: confirm at send time, and give the request a deadline below `fenceAfterMs`. Reproduced on R2 again:
  130 ms of overlap.

**Not tested.**

- **AWS S3 and Azure Blob** (no credentials).
- `ControlLease` on GCS (brief: R2 only; it needs a production GCS adapter first).
- R2 with multiple buckets/locations or jurisdictions.
- GCS dual- and multi-region buckets (the location was not read).
- Latency from a datacentre rather than home broadband.
- T4 case (d), the waited-for late 200, at the fetch layer. The rig never ran it on TLS stores.
- R2's documented per-key write limit: not reached at 4.6 writes/s sequential.
- The 429 error reason from GCS: the rig records the status only in the contention phases.

**Deviations from the brief and plan.**

- **Tightening T6** (the read token of a lease-sized body satisfies the condition), gating for all stores.
  It was added after T5 failed on R2 and the cause was found.
- The **flood was capped at 2,000 attempts** per store for cost (rounds kept the full 10,000).
- **GCS gating**: the S3-dialect "unsupported condition", "losers only 409/412", and the 300 ms p99 bound are
  recorded but not gating for GCS. S7 words them as "record" and "report", and its adapter never sends
  S3 headers.
- The **R2 identity-read run** (`r2-identity`) is a prototype of a client change inside the rig. Production
  code is untouched. The 200-writer contention was not repeated with it, because the contention bodies are
  below the gzip threshold, so the result is identical.
- The **GCS key path** in the creds file is relative to its directory. The run command resolves it there;
  the rig itself reads only the environment.
- **docs/HA-PLAN.md was not read.** It exists only as uncommitted work in the owner's main checkout, which
  the credential rule forbids reading beyond the creds files. The S7 criteria were taken from the brief.

## S4 — One certificate, issued once, on every ingress: local half (2026-11-20)

Question, criteria and fallback: [`spikes/s4-certificates/README.md`](../spikes/s4-certificates/README.md)
(CLUSTERING §15.2 S4, §7.3; HA-PLAN H20, O1, W2). Rig: `spikes/s4-certificates/run.sh` (one command;
builds three images, runs every scenario on an `--internal` bridge, removes everything).

**Environment.** Apple M3 Pro, macOS 27.3, OrbStack Docker 29.8.2, Bun 1.4.5 on the host, shared with
other lanes. Pebble and pebble-challtestsrv 2.10.3 (by digest); Yoal's pinned Caddy **2.11.8** (xcaddy
v0.4.7, caddy-dns/cloudflare v0.2.4) built with certmagic v0.25.6 **plus**
`github.com/techknowlogick/certmagic-s3@v1.5.0` (design A) or `github.com/ss098/certmagic-s3@8af482af`
(the no-lock control); the module's `go 1.26.0` directive built it with Go 1.26.0, not release.yml's
1.24. lego v5.6.0; HAProxy 3.4.8 (plain TCP round-robin on :80 and :443, no health checks); MinIO
`RELEASE.2025-09-07` community image by digest (as S2); three ingress containers (Debian 13). Pebble
issues **240 s certificates** (renewal at 1/3 left = 160 s), no authorization reuse, and makes **three
concurrent validations per challenge, all of which must pass**, so through round-robin every HTTP-01
challenge reaches every ingress. Compression: the plan's 90-day certificate and 30-day renewal window
become 240 s and 80 s (≈ 32,400×); the 6 h control-plane outage becomes **40 s, half the renewal
window** (the plan's is 1/120 of it), starting 5–10 s before renewal is due.

**Designs run.**

| Key | Issuer | Distribution | HTTP-01 behind the balancer |
|---|---|---|---|
| **A** | Each ingress's Caddy; certmagic storage on MinIO via certmagic-s3 v1.5.0, whose lock is `If-None-Match: *` / `If-Match` on an object with a nanosecond body (so MinIO's MD5 ETag still changes per write), 2 min expiry, 5 s refresh, stale judged by the store's clock | certmagic reloads a newer certificate from storage when its own copy is due | certmagic's distributed solver: any ingress answers from the token in storage |
| **B** | lego on a "control plane" container; renew at 1/3 left, retry every 5 s | Agent pulls every 2 s, writes 0640 root:caddy by atomic rename, `load_files` + one `POST /load` (CLUSTERING §7.3 as written) | Every ingress relays `/.well-known/acme-challenge/*` to the issuer (H20) |
| **B-hot** | As B | As B, but Caddy gets the pair from the agent on each new handshake (`tls.get_certificate` http, loopback), so nothing reloads | As B |
| A-nolock | As A with ss098/certmagic-s3, whose `Lock()` returns nil | As A | As A |
| A-local | Each ingress alone, file storage (today's per-node ACME; the fallback without a relay) | none | none |

**Numbers per criterion.**

| # | Criterion | A (shared storage) | B (file + `/load`) | B-hot (agent → `get_certificate`) |
|---|---|---|---|---|
| 1 | One fingerprint on all ingresses | **PASS** at start: one cert on all three 2.3 s / 2.8 s after a simultaneous start, 1 issuance. Every renewal reached all three within 0–2 s (watch every 500 ms). **Broken after a forced reissue** (row "removal") | **PASS**: all three in 6.7 s from cold start; each new generation on every ingress ≤ 1.9 s after issuance (2 s poll; `POST /load` 5–36 ms) | **PASS**: 6.7 s cold; every generation on all three ≤ 1.9 s after issuance |
| 2 | One issuance per name set per renewal window | **FAIL**: 6 issuances in 8 min in run 2 (expected 4; a forced reissue not counted), 6 in two lifetimes in the diagnostic run (expected 3), including **two renewals of one certificate 2 s apart** under the lock. Every early renewal logged "needs renewal based on ARI window" with no selected time | **PASS**: issuances at 0, 163 s, 361 s (after the outage); exactly one per window | **PASS**: 0, 162 s, 364 s; one per window |
| 3 | ≤ 0.1% of 1,000 keep-alive connections dropped by a renewal | **PASS**: 0 of 1,000 across 5 renewals (two holds, 270 s and 206 s; 236,737 requests, 0 failed). certmagic swaps the cached certificate; nothing reloads | **FAIL**: **1,000 of 1,000** per reload, twice (976 idle connections closed by the server + 24 requests in flight failed; then 990 + 10). Every `POST /load` closes every idle keep-alive connection | **PASS**: 0 of 1,000 across 2 renewals (210,206 requests, 0 failed) |
| 4 | A control-plane outage does not stop renewal of the file on disk | **PASS (n/a by design)**: no control plane in the path. The equivalent, **MinIO down 40 s across the renewal point**: renewal failed on the storage check, retried on certmagic's ~65 s backoff, renewed 36 s after MinIO returned, **14 s before expiry**; 0 drops, no expired certificate served (run 1; in run 2 ARI renewed before the outage began, so it covered no renewal point) | **PASS**: issuer down 07:31:50–07:32:30 across due 07:31:55; all ingresses kept serving the old file (0 errors, 0 expired served); renewed 4 s after return, on all three 39 s before expiry, 1 issuance. (Drops are criterion 3's) | **PASS**: same shape; on all three 36.6 s before expiry; 0 drops |
| 5 | HTTP-01 when the challenge lands on a non-holder; fails without the relay | **PASS without a relay**: every validation of every order was answered, the non-issuing ingresses from storage (`"distributed":true`); 0 invalid authorizations in 7 + 6 orders | **PASS with the relay**: each of the three ingresses relayed one of Pebble's three validations, 200 each. **Without it: 4/4 and 5/5 orders invalid** (each ingress answered 308; no certificate) | As B |

Controls: **A-nolock**: at start 3 orders, 2 invalid, 1 issuance, 61 s until all served it; over the
next window **6 orders, all invalid, 0 renewals**, so all three served an expired certificate. The
instances overwrite one another's HTTP-01 token in shared storage, so a missing lock does not only
waste issuances, it makes validation fail. **A-local**: 6 orders, 6 invalid, no certificate on any
ingress after 90 s; each ingress knows only its own token and Pebble asks all three.

**Ingress removal.** **A:** removing ing-c reissued nothing. Deleting the certificate from storage and
reloading ing-a's config (`Cache-Control: must-revalidate`) issued nothing either: the certmagic
cache survives a config load. Restarting ing-a's process issued a new certificate in 2.1 s, but **ing-b
kept the old one** (171 s left, outside its 80 s window): certmagic only reads storage for a
certificate that is itself due (`maintain.go`). Two fingerprints then stay live until the next window
(on Let's Encrypt, up to about 60 days) unless every ingress restarts. **B / B-hot:** `POST /reissue`
issued in 6.8 s / 4.8 s, and both remaining ingresses served it 7.9 s / 5.6 s after the request.
Both designs also need the balancer to drop the removed node first: with ing-c gone but still in
HAProxy, one of Pebble's three validations timed out on it and every order failed.

**DNS-01** (lego `exec` → challtestsrv): `*.s4.test` + `s4.test` in one order, issued in 69 s (most
of it lego's propagation polling). Cloudflare, Azure DNS and Route 53: **not run** (need real zones).

**Key custody.**

- **A:** keys live in the bucket; client-side `encryption_key` (secretbox) is optional and the same
  key is on every ingress. Every ingress holds S3 credentials that can read and write every
  certificate's key in the prefix. The master key cannot seal them without forking the module.
  Removing an ingress means rotating the bucket credential and the encryption key, as well as
  reissuing.
- **B:** the issuer holds the key, and it can be sealed with the master key at rest (not modelled:
  the rig keeps it in the container). Ingresses got `/etc/caddy-certs/gen-N.{crt,key}` as 0640
  root:caddy, written by root, with Caddy running as `caddy`. Exactly HA-PLAN §10.
- **B-hot:** as B on disk, plus the agent serves the pair on a loopback port to anything that knows
  the token in Caddy's config. Caddy's http manager can send no header, so production wants a unix
  socket or peer check. That is a code change in Caddy's manager or a small Caddy module.

**ACME lease.** A's certmagic-s3 lock behaved as a correct mutex on MinIO: no "replaced stale lock"
in the logged runs. The duplicates came from ARI after the lock, not from the lock. A store that ignores
conditions (Garage, S3) degrades A to A-nolock: duplicates *and* failed validations. B needs no
storage lock for issuance. One issuer per control plane holds it, and the HA-PLAN ACME lease only
picks which control-plane node runs it. A double issuance in B (two control planes during a lease
overlap) costs one duplicate order, and agents take the higher generation.

**Verdict.**

- **O1: control-plane issuer (B), delivered without a config reload (B-hot).** It is the only design
  that passed all five criteria here.
- **Caddy holder (A)** passed 1, 3, 4 and 5 and has the best HTTP-01 story (no relay needed). It
  failed criterion 2 through certmagic's ARI renewal logic. Forced reissue after an ingress removal
  does not reach the other ingresses. Its keys sit in a bucket every ingress can read, unsealed by the
  master key.
- **B as CLUSTERING §7.3 writes it** (`load_files` + `POST /load`) fails criterion 3 outright.

**Fallback triggered:** none for O1. Per-ingress ACME (A-local), the agreed fallback, **fails behind
any balancer that spreads one challenge's validations** unless the relay sends them all to one
holder. So the relay is mandatory in the fallback too, as the plan already says.

**What this proves wrong in the plan.**

- CLUSTERING §7.3 *Distribution*: "loads it from file (`certificates.load_files`) … every ingress
  reloads" costs every keep-alive connection on every ingress per renewal. It must be a hot swap.
  The rig's `get_certificate` path did it with 0 drops; a Caddy module that reads the agent's
  delivered file is the production shape. The same reload drop applies to the agent's full-config
  `POST /load` on every reconcile today (`apps/agent/src/main.ts` `applyFullConfig`), as S9
  measures.
- CLUSTERING §7.3 *ACME lease* and *Custody* (holder Caddy + copy-out) is A's issuance plus B's
  distribution. It inherits A's ARI duplicates and B's reload. Issue in the control plane instead;
  the lease then only elects the issuing control-plane node.
- HA-PLAN H20 HTTP-01 relay "to the current ACME lease holder": correct and needed. It must also
  cover a removed or unhealthy ingress still in the pool, since a CA with multi-perspective
  validation fails the whole order if one perspective times out. W8's health endpoint has to eject
  first.
- A Caddy automation policy that lists `subjects` with no `issuers` silently uses the public Let's
  Encrypt and ZeroSSL CAs. Yoal configs that use managers must set an explicit issuer.

**Not tested.** Real CAs (Let's Encrypt ARI windows; whether certmagic's empty-selected-time path
occurs there; real rate limits), DNS-01 on Cloudflare, Azure DNS and Route 53, real hours-long
outages, sealing with the master key, the activation endpoint itself (stood in by a 2 s poll),
`tls-alpn-01` (disabled), more than one name per set in A, Linux hosts or VMs (containers on macOS),
and a soak.

**Incident in this lane.** One B-hot attempt had a policy with `subjects` and no issuer. Its three
ingresses registered **six ACME accounts** (three on Let's Encrypt production, three on staging, no
contact address) and sent at least six orders, all refused (`b.s4.test` has no public suffix), before
the run was stopped at about 07:42 UTC. No certificate was issued and nothing identifying was sent.
The rig now runs on an `--internal` network, gives every policy an explicit issuer, and fails a
scenario if any container logs a public ACME endpoint.
