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
