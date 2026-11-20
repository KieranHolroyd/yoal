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
