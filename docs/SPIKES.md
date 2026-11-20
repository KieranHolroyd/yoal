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
