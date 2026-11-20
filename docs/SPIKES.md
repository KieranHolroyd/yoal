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

## S4 (cloud): DNS-01 on Cloudflare (2026-11-20)

Question, criteria and fallback: [`spikes/s4-certificates/README.md`](../spikes/s4-certificates/README.md),
section "Cloud half" (HA-PLAN H20 item 1, §4 W2 S4). Rig: `spikes/s4-certificates/cloud.sh` (one
command; sweeps the zone and deletes every key on exit).

**Environment.** Apple M3 Pro, macOS 27.3, OrbStack Docker 29.8.2, Bun 1.4.5. CA: **Let's Encrypt
staging only**. Every rendered Caddy config and lego argument list was grepped for
`acme-v02.api.letsencrypt.org` and `zerossl` before each run; both hosts resolved to 127.0.0.1 in the
clients; no client log named either. One ACME account (`acct/374986333`, no contact) was registered
by lego and reused by Caddy through `account_key`. Zone: a real Cloudflare zone (active, full setup).
`<zone>` is a one-label subdomain inside it, and records were named `_acme-challenge.yoal-w0-s4-xxxx.<zone>`.
Token: the one `CF_API_TOKEN` (owner: `Zone:DNS:Edit` on that zone). Clients:
**(a)** lego v5.6.0 `cloudflare` provider (design B's issuer);
**(b)** Yoal's pinned Caddy 2.11.8 built as `release.yml` does (xcaddy v0.4.7, caddy-dns/cloudflare
v0.2.4 → libdns/cloudflare v0.2.2, certmagic v0.25.6, acmez v3.1.7; toolchain go1.26.0, see below).
Neither client was tuned (default propagation checks and timeouts). They ran in containers with
public resolvers. Every Cloudflare API call went through a rig CONNECT proxy that could black out
`api.cloudflare.com` (open tunnels closed, new ones closed unanswered). Outside measurement: the
API every 1 s, and every IPv4 address of the zone's two nameservers (6) every 250 ms.

**Numbers per criterion.**

| # | Criterion | (a) lego (control-plane issuer) | (b) pinned Caddy |
|---|---|---|---|
| 1 | Issues `*.<l>.<zone>` + `<l>.<zone>`, ≤ 300 s | **PASS**: **one order, one certificate** with exactly both SANs, issuer `(STAGING) Baloney Bulgur YE2`, **25.1 s** from start. lego solves the two authorizations one after the other | **PASS, two orders**: certmagic issues one certificate per name, so the pair is two orders, two certificates and two keys, solved in parallel. Both in **24.2 s**, about 10 s of it one DNS timeout in zone discovery; a single name took **12.1 s** |
| 2 | Propagation: default check passes; every authorization valid first try | **PASS**: TXT on all 6 authoritative addresses **3.5–3.7 s** after creation. lego's own wait: first recursive check NXDOMAIN at +2.1 s, passed at the next 2 s poll; validated **8.5 s** after it began waiting. 3 of 3 authorizations valid first try | **PASS**: all 6 at **3.6–3.7 s**; certmagic's check passed **4.4–4.5 s** after creation (two polls 2 s apart); challenge accepted 0.2 s later. 3 of 3 valid first try |
| 3 | The one `Zone:DNS:Edit` token is enough | **PASS**: zone lookup by name (`GET /zones?name=<apex>`), create, delete | **PASS**: same calls through libdns |
| 4 | No `_acme-challenge` TXT left ≤ 60 s after the certificate | **PASS**: both records deleted 18.8 / 19.1 s after creation, before finalize | **PASS**: deleted 7.9 s after creation |
| 5a | API unreachable 60 s from the first API call: fails without hanging, retries, issues, ≤ 3 orders, no TXT | **PASS in part**: the zone lookup failed (`unexpected EOF`), and lego deactivated the authorization and exited 1 **0.37 s** later (2 s in all), 1 order, no record. lego is one-shot, so the retry belongs to the issuer loop and was **not run** (order budget) | **PASS in part**: the first attempt failed **0.38 s** after it began presenting (zone lookup `unexpected EOF`), with no record created, and certmagic logged `will retry … attempt 1, retrying_in 60` (its schedule is 1, 2, 2, 5, 10 … min, up to 30 days). The successful retry was **not observed**: this run came from a rig bug and was stopped at its cap |
| 5b | API unreachable 60 s from the moment the TXT exists: no stale TXT 120 s after | **FAIL**: issued anyway (12.3 s). Cleanup failed at once (`Cleaning up failed … unexpected EOF`, **WARN**) and was **never retried**. The record was still there **553 s** later, when the sweep deleted it | **FAIL, silently**: issued (12.1 s). **No error was logged**, and the record was still there **298 s** later (sweep). Cause: libdns/cloudflare v0.2.2 `getDNSRecords` ignores `doAPIRequest`'s error on the TXT content-match path (`client.go:92`), so `DeleteRecords` finds nothing and returns success. Any API failure at cleanup (unreachable, 5xx, 429) leaks the record without trace |

Orders: **9 of 10** (lego 5, Caddy 4). Two lego orders failed before the lab DNS fix (OrbStack's
container resolver timed out on lego's recursive check; lego waited its full 120 s per
authorization, failed, and deleted both records). One Caddy order was the 5a attempt above. The
final sweep found exactly the two 5b records, deleted them, and found none left. Afterwards,
records of any type whose name contains `yoal-w0-s4`: **0**. Certificates, keys and the account
were deleted from disk.

**Verdict.** DNS-01 against a real Cloudflare zone **works for both designs** with the one
`Zone:DNS:Edit` token: 12–25 s per issuance, with propagation (under 4 s) a small part of it. Both
designs leak the challenge record when the API fails between present and cleanup, lego with a
warning and Caddy silently. **O1 is unchanged: control-plane issuer (B).** DNS-01 strengthens the
case: lego puts the wildcard and the apex in one order with one key, where Caddy needs two of each.
The issuer must own cleanup: after each order, and on a timer, list `_acme-challenge.*` TXT records
whose value it presented (or older than one order's lifetime) and delete them, retrying with backoff.
Yoal's Caddy path has the same leak today and nothing that sweeps it.

**Fallback triggered:** none.

**Azure DNS and Route 53: not run** (no credentials).

**What this proves wrong in the plan or the code.**

- `release.yml` pins `GO_VERSION: '1.24'`, but Caddy 2.11.8 itself declares `go 1.26.0`. The
  release build is go1.26.0 by toolchain auto-download, not 1.24. The local half attributed this to
  the S3 storage module; it is Caddy.
- CLUSTERING §7.3 and the threat model assume a failed renewal step costs only a retry. On
  Cloudflare, a failed cleanup costs a stale TXT record that no client removes. Cloudflare caps the records
  in a zone, so a long API incident over many renewals accumulates records toward that cap. The issuer needs a
  sweep (above), and per-ingress Caddy (the fallback) needs one too, or a libdns fix.
- The threat model (CLUSTERING, "DNS or Cloudflare compromise") places the token in `agent.env`.
  The code compiles it into the Caddy JSON itself (`packages/site-config/src/compile.ts:395`,
  `apps/agent/src/caddy-config.ts:134`: `api_token: tls.cloudflareApiToken`). It therefore lives in
  Caddy's loaded and autosaved config. The rig used `{env.CF_API_TOKEN}`, which Caddy resolves at
  provision time, and that worked. Seen in passing, not tested further.
- Caddy cannot issue one certificate for a name set. "One certificate per name set" (H13) holds only
  for an issuer outside Caddy.

**Not tested.** The issuer loop's retry for lego and an observed successful Caddy retry (order
budget); blackouts at other points (between order and present; during propagation only); API 5xx
or 429 instead of unreachable; renewal (the staging certificates were 64-day; ARI windows reported
but not exercised); a proxied-only zone or Origin CA; Azure DNS, Route 53; Linux hosts (containers
on macOS).

## S9 — Ingress behind a load balancer: HAProxy and keepalived (2026-11-20)

Question, criteria and fallback: [`spikes/s9-balancers/README.md`](../spikes/s9-balancers/README.md) (HA-PLAN
§4 W2 S9; H18, H19; §1.2 row 1; §10). Rig: `spikes/s9-balancers/run.sh` (one command; builds the image,
runs every scenario, removes every container, the network and the image). This is the **local half**:
Azure LB, AWS NLB and Hetzner LB need a cloud project and the owner's approval and were not run.

**Environment.** Apple M3 Pro, macOS 27.3, OrbStack Docker 29.8.2 (kernel 7.2.12-orbstack), host Bun 1.4.5,
shared with other lanes (load average 9–13 on 11 CPUs during the runs). One bridge segment, all containers
`yoal-w0-s9-*`, no published ports.

| Part | Version |
|---|---|
| Ingress Caddy | **v2.11.8** built by xcaddy v0.4.7 with `caddy-dns/cloudflare` v0.2.4, exactly as `release.yml` builds it (go1.26.0 by `GOTOOLCHAIN=auto` from Go 1.24; `pires/go-proxyproto` v0.15.0), on Debian 13 (`trixie-slim`) |
| keepalived | 2.3.3, Debian 13 package (built without `track_process`) |
| HAProxy | 3.4.8 LTS (`haproxy:3.4.8-alpine`) |
| Upstream app, load generator, probes | Bun 1.4.4 (release pin), `oven/bun:1.4.4-alpine` |

**Method.** Every scenario ran in at least two full passes (the last one `run.sh` end to end); the earliest
runs had `on-marked-down shutdown-sessions` in HAProxy and are reported separately. Three ingress containers with Caddy configs from the real `compileCaddyConfig` (a two-copy app
with `least_conn` and active checks, a static site, today's `remote_ip` Kubernetes allowlist via
`compileKubernetesRoute`, TLS from Caddy's internal CA instead of ACME) plus the S9 prototype
(`render.ts` `applyIngressPrototype`): health route on `:443`, `:80` and a plain health server (8099),
state files `/run/yoal/health/{ready,drain}` read by the `file` matcher, `Connection: close` while
draining, `proxy_protocol` wrapper (`allow` = HAProxy, `fallback_policy: ignore`) before `tls`, and
`trusted_proxies` with `client_ip_headers`. HAProxy fronts the set twice: `mode tcp` on 443 with TLS
passthrough and `send-proxy-v2` (the cloud L4 shape), and `mode http` re-encrypting to 443 with
`send-proxy-v2` and `sni req.hdr(host)`. Checks: `option httpchk GET /.well-known/yoal/health`, port 8099,
`inter 5s fall 2 rise 2`, `timeout check 2s`. keepalived on two ingress nodes (VRRP auth `PASS`,
`track_file`, no script). The load generator speaks raw HTTP/1.1 and logs every request: 200 req/s, half
on 20 keep-alive connections, half on a new connection each; a request fails on connect error, reset,
early close, 5 s timeout or non-2xx.

**Numbers per criterion.**

| # | Criterion | Result | Verdict |
|---|---|---|---|
| 1a | Killed ingress out of rotation ≤ 15 s (HAProxy, 5 s / fall 2) | `docker kill` at 200 req/s, 6 runs: HAProxy DOWN after 9.2–13.1 s (`mode tcp`) and 9.8–13.3 s (`mode http`); last failed request ≤ 0.08 s after the kill; failed requests 1, 0, 0, 0, 0, 0 of ~9,000 per run (the 1 was an in-flight new connection, in a run with `on-marked-down shutdown-sessions`) | **PASS** |
| 1b | Lame-ducked ingress removed with **zero** failed requests, keep-alive and new connections | `drainSeconds` 20, then admin `POST /stop` (returns in 50–613 ms). HAProxy DOWN 5.2–9.9 s after the drain began; **0 requests answered by the node after it stopped** in every run. Failed requests per run: `mode tcp` + `Connection: close` **0 in 10 of 11 runs**; `mode http` + close 0 in 6 of 6; `mode tcp` without close 0 in 6 of 6. The one bad run had 1,043 timeouts across 9–35 s, **starting 1 s before the drain began**, on every node; it did not recur in 8 reruns, including the same order (lame duck right after a kill). Cause unknown; host load was 10–13. With `on-marked-down shutdown-sessions` (first runs) 3 of 5 `mode tcp` runs lost exactly 1 request, reset at the instant HAProxy marked the node DOWN | **PASS** (22 of 23 runs at zero; the unexplained stall is reported, not excluded) |
| 2 | True client address with PROXY v2; forged PROXY or XFF from an unlisted source not believed; no crash on garbage | 67 of 67 cases pass (twice). Through HAProxy (`tcp` and `http`) `remote.host`, `client_ip` and the access log all show the client. From an unlisted source, forged PROXY v1 and v2 on 443, 80 and 8099 are read and discarded (address = the real peer); forged XFF ignored; both allowlists (`remote_ip` and `client_ip`) refuse a forged allowed address (403); a PROXY header smuggled through HAProxy `tcp` breaks the TLS handshake. Six garbage cases × three listeners × two sources (unlisted, and from HAProxy's own namespace): every listener keeps serving, Caddy PIDs unchanged; a header that never finishes is cut at the 5 s wrapper timeout | **PASS** |
| 3 | VIP moves ≤ 5 s when the master dies; VRRP auth on, no script hooks | Two runs each. Master container killed at 200 req/s: first success on the backup **2.75 s and 3.36 s** after the kill; 14 and 21 failed requests (refused or reset at the kill instant). Fail-back on the master's return (preempt): 20 and 20 in-flight requests reset. **Caddy killed, keepalived alive: VIP never moves** (3,997 and 4,015 of 5,999 requests failed over 20 s; Debian 13's keepalived has no `track_process`). With the agent writing the `track_file` 1 s later: back in 1.7–1.8 s, 212–214 failed. VIP lame duck (drain 5 s, then `track_file` = 1): **0 failed** both runs, moved after 5.7 s | **PASS** for the criterion as written (node death); Caddy-only death needs the agent |
| 4 | Full `POST /load` with 1,000 keep-alive connections drops ≤ 0.1%; no in-flight request fails | Changed config, 1,000 idle TLS keep-alives, 50 slow (2 s) requests and 20 new/s across the reload: two runs each: **direct to Caddy 1,000 dropped (100%)**, every one a clean server close 36–184 ms after the call; **behind HAProxy `tcp` 1,000 dropped (100%)** (each close passes straight to the client); **behind HAProxy `http` 0 dropped**, all 1,000 answered a request afterwards. In-flight: 0 failures on every path (500 slow requests completed, ~385 new requests OK). An **identical** config posted again is a no-op: 0 dropped, 1,000 of 1,000 reused | **FAIL** direct and behind any L4 balancer; **PASS** behind an L7 balancer |
| 5 | Health body constant-size, no version or topology | 16 bytes in all three states (`ok`, `notready`, `draining`) on 8099, 80 and 443; `Server` removed; headers are `Content-Type`, `Cache-Control: no-store`, `Date`, `Content-Length`, plus `Alt-Svc: h3` on 443. `:443` **without SNI fails the TLS handshake** (no default certificate) | **PASS** |

**Verdict.** HAProxy and keepalived both work in front of the pinned Caddy, **with one failed criterion**:
a real config change closes every idle client keep-alive connection (Go's `Server.Shutdown` on the
replaced server), so behind an L4 balancer (HAProxy `tcp`, and by construction NLB, Azure LB and
Hetzner LB in TCP mode) criterion 4 fails at 100%. No request is lost (0 in-flight failures; a clean
FIN on an idle connection is retried by correct clients), but the ≤ 0.1% bound cannot be met by
configuration. The fallback (per balancer, unsupported) is **not** triggered for HAProxy: the
recommended HAProxy recipe is `mode http`, which met every criterion. For L4 balancers the plan has to
choose between relaxing criterion 4 to "no in-flight failure; idle closes allowed" and making reloads
rarer (the agent already sends one `POST /load` per reconcile; an unchanged config is free). keepalived
passes for node death; Caddy-only death needs the agent to write the track file (no script-free
alternative in Debian 13's build).

**What W8 builds** (details in the rig README): the state-file health route and dedicated listener; lame
duck as `drain` file → `drainSeconds` → `POST /stop`, with `Connection: close` while draining; the
`proxy_protocol` wrapper with `allow` = `trustedProxies` and `fallback_policy: ignore`, before `tls`;
`trusted_proxies` + `client_ip_headers`; allowlists on `client_ip`; one `@id` per server for the health
route (Caddy refuses duplicates at load; `caddy validate` does not); a `track_file` helper verb for `vip`.

**What this changed in the plan.**

- Criterion 4 (and S4's "reload with ≤ 0.1% dropped connections") is unattainable for any real config
  change behind an L4 balancer; only L7 balancers hide it.
- `trustedProxies` must list the addresses that **send** PROXY headers, not probe sources: with
  `fallback_policy: ignore`, a probe or client without a header from any address is accepted.
- `on-marked-down shutdown-sessions` must not be in the HAProxy recipe: it reset requests a draining node
  was still serving.
- HTTPS probes on 443 must send SNI (or the probe uses the plain port); Caddy has no default certificate.
- The `vip` driver cannot detect Caddy death without the agent (no `track_process` in Debian 13); H18's
  "VRRP detects failure" holds only for node or keepalived death. VRRPv2 `PASS` auth is cleartext on the
  segment. Preemptive fail-back resets in-flight requests.
- Caddy advertises `Alt-Svc: h3` on 443; behind a TCP balancer with PROXY protocol, HTTP/3 (UDP) bypasses
  both the balancer path and the client-address handling. H19 should turn HTTP/3 off on ingress nodes
  behind a balancer (not tested).

**Not tested.** Azure LB, AWS NLB, Hetzner LB (need credentials and money). A silent host death (power-off,
cable): `docker kill` makes the bridge answer with host-unreachable within seconds, so killed-node failure
counts are optimistic; the DOWN times hold (checks time out after 2 s either way). Caddy's own
`shutdown_delay` / `{http.shutting_down}` as an alternative lame duck. `fastinter`. `nopreempt`. HTTP/2 and
HTTP/3 clients (the load generator is HTTP/1.1). IPv6. Rate limiting of the health endpoint (no module in
the pinned build). TLS on a real ACME certificate.

## S9 (cloud): Hetzner Load Balancer (2026-11-20)

Question, criteria and fallback: [`spikes/s9-balancers/README.md`](../spikes/s9-balancers/README.md), section
"Cloud: Hetzner Load Balancer" (committed before any cloud code). Rig: `spikes/s9-balancers/cloud/run-cloud.sh`
(one command: inventory guard, live price check, create, every scenario, teardown on every exit path).
A first attempt stopped at the inventory guard (the token then pointed at the owner's production project);
the owner supplied a token for an empty project and the spike ran.

**Environment.** Hetzner Cloud, `hel1` (Helsinki): one **LB11** (algorithm `least_connections`, attached to
a private network `10.209.0.0/16` at `10.209.1.5`), three **`cpx02`** servers (1 vCPU, 1 GB, x86; the
cheapest Debian 13 type by live price) running **Debian 13** (kernel 6.12.107+deb13-cloud-amd64), targets
added with `use_private_ip`. On each node: the pinned **Caddy v2.11.8** (xcaddy v0.4.7, `caddy-dns/cloudflare`
v0.2.4, built for linux/amd64 with the same pins and `GOTOOLCHAIN=auto` as the local half) with the config
from the real `compileCaddyConfig` + `applyIngressPrototype()` (health route and plain listener on 8099,
state files, `Connection: close` while draining, `proxy_protocol` wrapper `allow` = `10.209.1.5/32`,
`fallback_policy: ignore`, `trusted_proxies` = the same), the rig's upstream app (Bun 1.4.4) on loopback,
TLS from Caddy's internal CA. Two LB services: **`tcp` 443→443 with `proxyprotocol`** (the shape under test)
and **`http` 8080→8081** (L7, to a plain-HTTP copy of the content server). Load generator, probes and API
polling ran on this Mac (Bun 1.4.5) over the internet to the LB's public IPv4. All resources labelled
`yoal-w0=s9`, named `yoal-w0-s9-*`, fresh SSH key.

**LB health check used (the tightest the API accepts).** `http` to port **8099**, `GET /.well-known/yoal/health`,
status `200`, **interval 3 s, timeout 1 s, retries 1**. The API refuses interval < 3 ("Must be between 3 and
60") and retries < 1 ("between 1 and 5").

**Method.** Same failure definition as the local half: a request fails if it was written and did not get a
`2xx` (connect error, reset, early close, 5 s timeout, non-`2xx`); 200 req/s, half on 20 keep-alive
connections, half on a new TLS connection each. "LB unhealthy" is the first 1 s API poll
(`GET /load_balancers/{id}`) that shows the target not `healthy`, so it includes up to ~1 s of polling lag.
Kill times are taken just before the fault call; a SIGKILL over SSH lands ~1.0 s after that (the SSH round
trip), a power-off API call returns in 0.18–0.20 s. **Two runs**: run 1 (steps one at a time) and run 2
(`run-cloud.sh` end to end), on separate infrastructure; numbers are pooled.

**Numbers per criterion.**

| # | Criterion | Result | Verdict |
|---|---|---|---|
| 1 | Killed ingress out of rotation ≤ 15 s | **Caddy SIGKILLed**, `tcp` service, 4 runs: LB unhealthy (443) 1.3–4.7 s after the call (≈ 0.3–3.7 s after the kill); failed requests **4, 5, 6, 5** of 9,786–9,999, every one within 1.01–1.06 s of the call (the kill instant: resets and in-flight EOFs), none later. Same through the `http` service, 4 runs: 0, 0, 0, 1 (`502`) failed; unhealthy 1.2–2.5 s. **Server powered off** (silent death, API `poweroff`), `tcp` service, 4 runs: LB unhealthy (443) **7.9, 5.7, 7.9, 4.6 s**; failed **15, 14, 18, 5** (connect and request timeouts); last failure **7.4, 6.5, 12.0, 6.2 s** after the call (completion time, so including the 5 s client timeout); 0 failures after 15 s | **PASS** |
| 2 | Lame-ducked ingress drains with zero failed requests | `drain` → 20 s → admin `POST /stop` (returns in 0.96–1.30 s over SSH), 200 req/s: **0 failed of 8,999 in 10 of 10 runs** (6 through `tcp`, 4 through `http`); **0 requests answered by the node after its Caddy stopped**; LB marked it unhealthy 1.2–4.7 s after the drain began; the draining node still answered 116–272 requests (with `Connection: close`) before the LB stopped sending | **PASS** |
| 3 | True client address via `proxyprotocol`; forgeries not believed | **38 of 38 cases, both runs.** Through `tcp` + PROXY: `remote.host`, `client_ip` and the access log show this Mac's public address; client-sent XFF ignored; a PROXY header smuggled through the LB breaks the TLS handshake; Host routing and both allowlists admit the real client. Through `http` (L7): `client_ip` = the Mac (from Hetzner's X-Forwarded-For, which appends to a forged one; Caddy takes the right-most untrusted), `remote.host` = the LB's private address, so the `remote_ip` allowlist (today's Kubernetes one) **refuses the real client (403)** and the `client_ip` one admits it. Forged PROXY v1/v2 and XFF sent straight to a node's public :443, :80, :8099, :8081 from the Mac: answered, not believed. From another node (`ing-b`, outside the list) to `ing-a`'s private and public address, PROXY v1 or XFF claiming the allowed address: **403** on both allowlists. Garbage (random 4 KiB, oversized v2 length, never-finishing header) on 443, 80, 8099: listeners keep serving. **Sources:** health probes and proxied connections both come from the LB's **private address `10.209.1.5`** (tcpdump on a node; no other source seen); probes carry **no PROXY header** even on the `proxyprotocol` service, and send `Host: <LB public IPv4>`. `trusted_proxies` and the wrapper's `allow` need exactly the LB's private address | **PASS** |
| 4 | Changed-config `POST /load` with 1,000 keep-alives through the LB: ≤ 0.1% dropped, no in-flight failure | 1,000 idle TLS keep-alives + 50 slow (2 s) + 20 new/s; reload on all three nodes. **`tcp` service, 4 runs: 1,000 of 1,000 dropped (100%)** each, 1.0–1.6 s after the call (clean server closes passed through), and **1, 2, 3, 3 in-flight failures** (requests on brand-new connections that got EOF at the reload); slow requests all completed. **Direct to Caddy** (no LB), 2 runs: 100% dropped, 3 and 3 failed the same way, so the in-flight failures are Caddy's, exposed by internet latency (the local half, at LAN latency, saw 0). **`http` (L7) service, 7 runs: 0 of 1,000 dropped** in every run (the LB keeps the client side); **one `502`** on a new request at the reload instant in **3 of 7** runs, 0 in 4. Identical-config controls: `tcp` 0 dropped / 0 failed (3 runs), `http` 0 / 0 (2 runs). Separately, 1,000 requests sent at once on the held L7 connections time out (724–894 of 1,000 at 5 s) **with or without a reload** (control: 860 and 862 with an identical config), an LB11 L7 limit, so the reload runs verify at 200/s | **FAIL** (`tcp`: 100% dropped and 1–3 in-flight failures; `http`: 0 dropped but a `502` in 3 of 7) |

**Verdict.** The Hetzner Load Balancer meets S9 for **health-checked removal, lame duck and client
address**: with the API's tightest check (3 s / 1 s / 1 retry) a silently dead node is out in ≤ 8 s and a
crashed Caddy in ≤ 4 s, the state-file lame duck drains with zero failures, and `proxyprotocol` plus a
one-entry `trusted_proxies` (the LB's private address) gives the true client address and believes no
forgery. **Criterion 4 fails**, as the local half predicted for every L4 balancer: a changed config closes
every idle keep-alive (100%), and over real latency also fails 1–3 requests sent on new connections at the
reload instant, with or without the LB. Hetzner's L7 service hides the idle closes but returned a `502` at
the reload in 3 of 7 runs and cannot reach Caddy's 443 (plain HTTP to the target only).

**Fallback triggered (HA-PLAN §4 W2).** Per balancer, documented as unsupported for the failed
property: the Hetzner recipe is supported for removal, drain and client address, and is documented as **not
meeting the reload bound**, the same plan-level choice the local half raised (relax criterion 4 to "no
in-flight failure; idle closes allowed" or make reloads rarer). New for that choice: even "no in-flight
failure" does not hold over the internet for a real config change (1–3 per reload at 20 new connections/s).

**Recipe sketch (tested; API bodies in the rig README).** LB in the ingress nodes' location and network zone,
attached to their private network at a fixed address; `tcp` 443→443 with `proxyprotocol: true`,
`least_connections`; health check `http` port 8099 `/.well-known/yoal/health` `200`, interval 3, timeout 1,
retries 1; targets with `use_private_ip`. Yoal: `ingress.proxyProtocol: v2`, `trustedProxies: [<LB private
IP>/32]`; allowlists on `client_ip`. The health route must answer any Host (probes send the LB's IP).
Not recommended: the `http` service as the default path.

**Cost.** Live prices (EUR/h incl. 20% VAT): LB11 0.01344, `cpx02` 0.0096, primary IPv4 0.00096. Projected
before creating (3 h): €0.135, under the €2 cap. Actual, from the rig's ledger (lifetimes × prices): run 1,
4 resources for 40.7 min; run 2, 4 resources for 19.6 min; **€0.090 billed** (each resource billed one
started hour per run) or €0.045 pro rata. Traffic stayed within the included volume. Teardown after each run
listed every resource kind by label `yoal-w0=s9` (servers, load balancers, networks, firewalls, primary and
floating IPs, volumes, certificates, SSH keys): **none remained**, and the whole project inventory was empty
(re-checked independently at 09:33 UTC).

**What this changed in the plan.**

- HA-PLAN §1.2's "probing every 5 s, 2 failures" is not Hetzner's floor: its minimums are interval 3 s,
  retries 1, timeout 1 s, which give ≤ 8 s for a silent death (measured 4.6–7.9 s).
- `trustedProxies` for Hetzner is one address, the LB's private IP; probes come from it too, without a
  PROXY header, which `fallback_policy: ignore` accepts.
- Criterion 4's "no in-flight failure" also fails over real latency for a changed config: new connections
  that arrive as the old server shuts down get EOF. Behind the L7 service it appears as a `502`.
- An L7 balancer puts its own address in `remote_ip`: today's Kubernetes allowlist (`remote_ip`) would
  refuse every real client behind Hetzner's `http` service (H19: allowlists must use `client_ip`).

**Not tested.** Azure LB and AWS NLB (no credentials). A Hetzner Cloud Firewall closing the nodes' public
443/8099 (recommended, so only the LB reaches them). Targets on public addresses (without a private
network). IPv6, HTTP/2 and HTTP/3 clients. TLS termination on the LB (`https` service). LB types above LB11
(the L7 burst limit may differ). Health check failure detection below the API's 1 s polling resolution.

## S10 — Container reaches the endpoint forwarder on the gateway address (2026-11-20)

HA-PLAN §4 W2 S10 (H24), closing CLUSTERING §15.2 S1, §17 Q7 and HA-PLAN O2. Rig:
`spikes/s10-gateway-forwarder/` (`run.sh` runs it end to end; question, criteria and fallback in its
README, committed before the rig).

**Decision: the Bun forwarder, with the restart fix below. Not `caddy-l4`.** O2's default stands; S1
and Q7 are closed. The fallback (a host-network sidecar per attached container) is not triggered.

### Environment

- Lima VZ VM `yoal-w0-s10` on this Mac: Debian 13 arm64, kernel 6.12.115, 4 vCPU, 4 GiB. Deleted
  afterwards.
- Podman 5.4.2 and netavark 1.14.0, run the way Yoal runs them: root Podman, system Quadlets,
  `UserNS=auto:size=65536`. Per-user rootless Podman with pasta (passt 2025-05-03) and slirp4netns
  1.2.1 was tested for (d) only.
- nftables 1.1.3; Bun 1.4.4 (the release pin).
- Postgres 18: `postgres:18-trixie`, `sha256:af98f9bf…`.
- Caddy 2.11.8 with `caddy-dns/cloudflare` v0.2.4 and `caddy-l4` v0.1.3, built by xcaddy v0.4.7
  exactly as `release.yml` builds Caddy, plus caddy-l4.

### Method

- **Workload.** A Yoal-shaped Quadlet `.container` on network `yoal-w0-orga` (gateway 10.89.1.1,
  bridge `podman2`) with `AddHost=db-s10:10.89.1.1`.
- **Database.** Postgres published on `127.0.0.1:15432` like a Yoal database. Also attached to
  `orga` as `pg-direct`, for the direct baseline.
- **Bun forwarders.** Each runs as user `yoal` with 200 consumer routes bound on `127.0.0.1` and the
  gateway.
  - Route 0 is the full production path: consumer, then pinned mTLS to a provider listener on an
    overlay address (a dummy interface, 10.47.0.1), then Postgres.
  - Route 1 is plain to `127.0.0.1:15432`. Routes 2–199 point at closed ports.
  - Behaviour copies the agent: `converge()` every 8 s with unchanged state, plus an edit to another
    route every ~56 s.
  - Variants:
    - **as-is**: the repo's `apps/agent/src/endpoints.ts` plus the minimal gateway-bind prototype
      (`make-proto.ts` applies it to the repo file at run time).
    - **fixed**: as-is plus the signature fix.
- **caddy-l4.** 200 layer4 servers on the same two addresses, route 0 plain to Postgres. A full
  config `POST /load` through the admin unix socket every 60 s, editing another route each time
  (S1's method).
- **Load.** A minimal Postgres wire client inside the workload container. Every failure is
  classified as reset, refused, timeout, EOF or server error.
- **Firewall.** The nft rule Yoal would write, one table:
  - input accepts `iifname podman2 ip saddr 10.89.1.0/24 ip daddr 10.89.1.1 tcp dport 21000-21999`,
    then drops any other non-loopback destination on 21000–21999;
  - output allows loopback connections to 21000–21999 only from the DynamicUser range
    (61184–65519) and from the agent user; everything else is reset.

### (a) Reachability — PASS

| From | Without the rule | With the rule |
|---|---|---|
| Container on `orga`, `db-s10:<port>` via `AddHost` (Bun plain, Bun mTLS, fixed, caddy-l4) | ok | ok |
| Container on another org network (`orgb`) → 10.89.1.1:21001 / :21500 | **ok** | dropped (timeout) |
| Host process as `nobody` → 10.89.1.1:21001 | **ok** | refused |
| Host process as root → 10.89.1.1:21001 | **ok** | refused |
| Host process as `nobody` → 127.0.0.1:21001 | ok | refused |
| Host process in a DynamicUser unit (a process app) → 127.0.0.1:21001 | ok | ok |
| Outside host routed to 10.89.0.0/16 via this host (netns + veth) → gateway:21001 / :21500 | **ok** | dropped (timeout) |
| Outside → host's eth0 address:21001 | refused | refused |

**Without the rule, the gateway listener is open to every other org's containers and to any
neighbour that can route to the container subnet** (Linux weak-host model). The rule is mandatory
for H24, not optional.

- Rootful Podman already writes `host.containers.internal` as the network gateway (10.89.1.1), the
  same address `AddHost` uses.
- A cgroup match (`socket cgroupv2 … "yoal-workloads.slice"`) cannot replace the uid range.
  nftables resolves the cgroup when the rule loads: it fails if the slice is empty, and goes stale
  if the slice is recreated.

### (b) S1 criteria on this path

**100,000 short connections per target** (concurrency 32; normal reloads running):

| Target | ok | Failures | p50 / p99 ms | Result |
|---|---|---|---|---|
| Bun as-is, mTLS | 99,958 | 16 reset, 26 refused | 28.3 / 83.5 | **FAIL** |
| Bun as-is, plain | 99,999 | 1 refused | 16.4 / 58.8 | **FAIL** |
| Bun fixed, mTLS | 100,000 | 0 | 24.7 / 89.0 | PASS |
| Bun fixed, plain | 100,000 | 0 | 20.9 / 48.2 | PASS |
| caddy-l4, plain | 100,000 | 0 | 21.7 / 54.1 | PASS |
| Direct (baseline) | 100,000 | 0 | 18.4 / 42.7 | — |

- These times are under saturation: concurrency 32 on 4 vCPU. The latency rows below are the
  measure that counts against the ≤ 2 ms criterion.
- The first pass of the as-is rows hit the VM's `nf_conntrack_max` of 65,536. A table-full
  condition dropped SYNs and gave about 300 timeouts per target, including the fixed variant. The
  rows above are reruns at 1,048,576, with 0 table-full drops.
- **Operational finding.** Each connection through an endpoint leaves two conntrack entries
  (container→gateway, then the forwarder→the DNAT'd loopback port), each held 120 s in TIME_WAIT.
  Nodes with endpoints need a raised `nf_conntrack_max`; the default fills at about 270 new
  connections/s.

**Latency** (5,000 sequential iterations, targets interleaved; added p99 is against direct):

| Target | `SELECT 1` p50 / p99 (added p99) | connect + query p50 / p99 (added p99) | Result |
|---|---|---|---|
| Bun fixed, mTLS | 0.169 / 1.670 (+0.54) | 1.621 / 3.614 (+0.16) | PASS |
| Bun fixed, plain | 0.140 / 1.012 (−0.12) | 1.060 / 3.157 (−0.30) | PASS |
| caddy-l4, plain | 0.153 / 2.392 (+1.26) | 1.101 / 3.179 (−0.28) | PASS |
| Direct | 0.062 / 1.134 | 1.034 / 3.455 | — |

**50 idle Postgres connections per target**, each checked every 30 s; reloads land while they are
idle. Run 3 alone was 239 checks, 11,950 per target. Across runs 1–3:

| Target | Idle lost | Result |
|---|---|---|
| Bun fixed, mTLS and plain | 0 | PASS |
| caddy-l4 | 0 | PASS |
| Bun as-is (runs 1 and 2) | 0 | PASS — the restart bug costs new connections, not open ones |

**RSS at 200 routes** (VmRSS; criterion ≤ 40 MB):

| Process | Idle, before load | After the bench and 2 h soak (300 open conns) | Result |
|---|---|---|---|
| Bun forwarder (fixed) | 35.2 MB | 51.2 → 53.0 → 57.2 MB (soak minutes 10–20, 55–65, 110–120) | PASS idle, **FAIL** under load |
| caddy-l4 (standalone Caddy) | 49.8 MB | 62.4 → 64.6 → 64.9 MB | **FAIL** both |
| Baselines | bare Bun 12.9 MB; bare Caddy with no apps 44.6 MB | — | — |

- The marginal cost is about 22 MB idle for the Bun forwarder and about 4–5 MB idle for caddy-l4.
- **Bun's RSS was still rising slowly (about +4 MB in the second hour) when the run ended. 2 h
  cannot tell GC drift from a leak; the 24 h soak must answer it.**

**Fd count** (sampled every 60 s): after the soak's 300 connections opened, Bun fixed held 708
(max 714) and caddy-l4 507–509 for the whole run; the first samples, before those connections,
were 408 and 407. **Flat, PASS.**

### (c) Soak — 2 h PASS (Bun fixed, caddy-l4); 24 h owed

| Run | Duration | Notes |
|---|---|---|
| Run 1 (all three forwarders) | 7 min | The VM stopped with my session. The as-is forwarder refused 2 connections per target; everything else was clean. |
| Run 2 | 89.5 min | Cut the same way; clean. |
| Run 3 | 2 h, 16:42:24 → 18:41:30 UTC | 239 checks recovered. The VM stopped 1 s before the soak's own summary line was written; the per-check rows are complete. |

Run 3 in detail:

| Target | Short connections | Failures | Idle lost |
|---|---|---|---|
| Bun fixed, mTLS | 35,340 | 0 | 0 of 11,950 |
| Bun fixed, plain | 35,340 | 0 | 0 of 11,950 |
| caddy-l4 | 35,340 | 0 | 0 of 11,950 |
| Direct | 35,340 | 0 | 0 of 11,950 |

- Reload work in run 3:
  - fixed Bun: 896 converges and 128 route edits, which restarted 255 listeners in total (the two
    edited routes each time, nothing else);
  - caddy-l4: 120 full-config loads.
- Across all runs caddy-l4 took 239 loads, all `200`: median 16 ms, p99 64 ms, max 141 ms.
- **The 24 h soak (and S1's 72 h fd criterion) is owed to the lab's weekly `ha-soak` job.** Its key
  measure is Bun's RSS slope.

### (d) Rootful and rootless details

- **The gateway is stable across restarts** (three VM reboots, Quadlet network service restarts):
  same subnet, gateway and bridge name every time. They persist in
  `/etc/containers/networks/*.json`.
- **The bridge exists only while a container is attached.** Netavark deletes it when the last
  container leaves and recreates it on the next start; after a reboot it is absent until a container
  starts.
- **Listeners bound before the bridge goes away survive it.** 400 of 400 gateway sockets stayed
  open, and both Bun and caddy-l4 served again as soon as the bridge came back.
- **A forwarder that starts while the address is absent cannot bind** (`EADDRNOTAVAIL`):
  - **Bun fixed:** 200 "could not listen" warnings; loopback listeners were unaffected. The gateway
    listeners never come back on their own, because `converge()` keeps the failed listener in its
    map with a matching signature. Still refused 70 s and 8 converges later.
  - **caddy-l4:** the whole `/load` fails with a 400 (`listen tcp 10.89.1.1:21620: bind: cannot
    assign requested address`) and **no** server starts. Loopback `127.0.0.1:21500` was refused
    too. The next periodic load after the bridge returned succeeded.
  - **With `net.ipv4.ip_nonlocal_bind=1`, both bind while the address is absent and serve once it
    returns.**
- **Recreating a network moves its subnet.** Removing `orga`, then creating another network
  (`orgc`), then recreating `orga` gave `orga` 10.89.3.0/24 on `podman4`, while `orgc` took the old
  10.89.1.0/24. The unit's `AddHost=…10.89.1.1` then pointed at another org's gateway and timed out
  (the nft rule, keyed to the old bridge and subnet, no longer matched).
- **Per-user rootless Podman (pasta default; slirp4netns tested):** a rootless bridge network's
  gateway (10.89.2.1) exists only inside the rootless network namespace, so no host process can bind
  it.
  - Containers reach the host only through pasta's mapped address: `host.containers.internal` is
    169.254.1.2.
  - With slirp4netns, 10.0.2.2 is host loopback; the host's own eth0 address is unreachable from
    pasta.
  - Every rootless connection arrives at the host as the rootless user's own process (uid 1000), so
    the uid rule above refused it. Isolation would be per uid, not per network.
  - The H24 design (bind the gateway) applies only to root Podman, which is what Yoal runs.

### Bugs found in the forwarder (`apps/agent/src/endpoints.ts`)

1. **Every `converge()` restarts every consumer listener and every plain provider listener, even
   with unchanged state.**
   - Consumers: the signature a listener stores (`apps/agent/src/endpoints.ts:120`,
     `` `${bind}:${port}->${targetHost}:${targetPort}:${fingerprint ?? 'plain'}` ``) never equals
     what `converge()` compares it with (`:41` against `signatureOf()` at `:169-171`,
     `` `${localPort}->${address}:${port}` ``).
   - Plain providers: `:131` stores `…:plain`, while `signatureOfProvider()` at `:173-175` ends with
     the (empty) fingerprint list, compared at `:49`. The mTLS provider (`:154`) does match.
   - The agent converges on every long poll (≤ 8 s, `apps/agent/src/main.ts:861`). Each converge
     closes and re-binds all consumer listeners: 200 per poll in the rig (1,400 after 7 polls).
     Open connections survive; new connections in the gap are refused or reset (42 of 100,000 above,
     2 per 7 min at 5/s).
   - **Fix (the `fixed` variant):**
     - store `signatureOf(endpoint)` at `:120`;
     - store `signatureOfProvider(provider)` at `:131` and `:154`;
     - add the fingerprint to `signatureOf()` so a re-pin restarts the listener.
   - The existing tests pass both ways; W4 needs a test that converges twice and asserts
     `stopped === 0`.
2. **A listener that fails to bind is never retried** (`:118` only logs the bind error; the entry stays in
   `consumers` with a matching signature). Bug 1 hides this today by rebinding everything every 8 s. Once bug 1 is fixed, a
   gateway bind that loses the race with the bridge stays dead until the agent restarts.

### What W4 must build with this decision

- **Gateway binding.** Bind the gateway addresses with retry: drop a failed listener from the map
  so the next converge retries it, or set `ip_nonlocal_bind=1` on the node.
- **Network units.** The control plane pins `Subnet=` and `Gateway=` in each org network unit, so
  `AddHost` survives network recreation.
- **Firewall.** One nft input rule per attachment network, re-rendered when that network changes.
  The loopback output rule keyed on the DynamicUser range and the agent uid.
- **Conntrack.** `nf_conntrack_max` sized for endpoint traffic.
- **Memory.** An RSS budget about 20–45 MB above today's agent. This FAILs S1's ≤ 40 MB under load;
  W4 should accept it or fix it with `--smol`/GC tuning, which this spike did not test.

### Why Bun over caddy-l4

With the fix, both pass the reload, idle and latency criteria. What separates them:

1. **Failure isolation.** caddy-l4 loads all-or-nothing: one unbindable gateway address (a
   network with no running container) fails the whole config, taking down every endpoint on the
   node, loopback included. If caddy-l4 lived in the node's main Caddy, as CLUSTERING §4.3 sketches,
   that same failed load would block site changes too. The Bun forwarder fails per listener.
2. **Coupling.** Every endpoint edit would be a full-config load of the node's Caddy and vice
   versa; the Bun forwarder's reconcile touches only the listeners whose signature changed.
3. **It exists.** Pinned mTLS on both sides, already wired to desired state. caddy-l4 needs a new
   module in the pinned build, pinning moved into Caddy configuration, and the unbuilt per-install
   CA.
4. **Latency is equal or better:** +0.54 ms p99 with mTLS versus +1.26 ms for caddy-l4 plain.

caddy-l4's advantage is memory: about 4–5 MB marginal versus about 22 MB idle, and its RSS was flat
over the soak. That does not outweigh 1 and 2.

### Not verified

- **The 24 h and 72 h soaks** (owed to `ha-soak`, above).
- **A real WireGuard hop between two nodes:** the overlay was a dummy interface on one host.
- **A real second host outside:** "outside" was a network namespace routed through the VM, a
  stronger case than an internet scan. Lima's user-mode network gave no way to reach the VM's
  address from the Mac.
- **caddy-l4 with mTLS upstreams:** caddy-l4 was measured plain only.
- **IPv6.**
- **Bun's `--smol` mode.**
- **Podman's own nftables firewall driver interplay:** netavark used its default here.
