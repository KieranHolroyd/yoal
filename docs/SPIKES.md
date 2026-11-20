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

Question, criteria and fallback: [`spikes/s9-balancers/README.md`](../spikes/s9-balancers/README.md),
section "Cloud: Hetzner Load Balancer". **Not run: the run stopped at the safety inventory.**

**What happened.** The brief's first API call is a read-only inventory of the Hetzner project
(`bun run spikes/s9-balancers/cloud/hcloud.ts inventory`, token from the environment of that one
command, never printed). The project behind the supplied `HCLOUD_TOKEN` is **not a throwaway**:
2 servers (`plausible`, `edge-b`, the owner's production worker), 0 load balancers, 0 networks,
0 firewalls, 1 SSH key (the owner's). By the brief's absolute rule the run stopped there: **no
resource was created, modified or deleted**, no price was fetched and nothing was spent (**€0**).

**Numbers per criterion.** None. Criteria 1–4 (killed node ≤ 15 s, lame duck with zero failures,
client address through `proxyprotocol`, reload under 1,000 keep-alives) are **untested** on the
Hetzner LB; the local half's results (section above) stand alone. Fallback: not triggered (no result).

**Not run.** Hetzner LB (wrong project, above). Azure LB and AWS NLB (no credentials).

**To run it.** A dedicated Hetzner project holding nothing but `yoal-w0*` resources, and a token for
it. The inventory guard (`cloud/hcloud.ts`) refuses any project with a server not named `yoal-w0*`
or with edge-b's address, and allows writes only to resources labelled `yoal-w0=s9`.
