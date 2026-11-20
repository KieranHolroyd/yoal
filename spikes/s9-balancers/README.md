# S9 (local half) — Yoal ingress behind a load balancer

Spike S9 of docs/HA-PLAN.md (§4 W2; H18, H19; §1.2 row 1; §10). Run by the CLUSTERING §15.1 rules:
this question, the pass criteria and the fallback were committed before any rig code.

This is the **local half**: HAProxy and `vip` (keepalived). Azure LB, AWS NLB and Hetzner LB need
a cloud project and money; they wait for credentials and the owner's approval.

## Question

Can a Yoal ingress node — the pinned Caddy build (2.11.8 with `caddy-dns/cloudflare` v0.2.4, built
with xcaddy v0.4.7 as `.github/workflows/release.yml` builds it), configured the way
`packages/site-config/src/compile.ts` and `apps/agent/src/caddy-config.ts` render it — sit behind an
operator's balancer with:

- **(a)** a health endpoint `GET /.well-known/yoal/health` on 80 and 443, plus a plain-HTTP listener on
  a dedicated port, answering `200` or `503` with a one-word reason;
- **(b)** lame duck: the endpoint answers `503` for `drainSeconds` while requests are still served, then
  Caddy stops gracefully;
- **(c)** PROXY protocol v2 and `trusted_proxies`, so the client address is correct in what Yoal's
  access rules would read, and is never trusted from an unlisted source;
- **(d)** a full-config reload (`POST /load`) under 1,000 keep-alive connections?

## Pass criteria (HA-PLAN §4 W2 S9, §1.2, §10; tightened where marked, never loosened)

1. **Removal.** HAProxy (current LTS), probing every 5 s with `fall 2`, takes a **killed** ingress out
   of rotation in **≤ 15 s**, and a **lame-ducked** one with **zero** failed client requests at
   **200 req/s** over keep-alive and new connections.
   - *Tightened:* "out of rotation" is measured two ways, both ≤ 15 s: kill → HAProxy marks the server
     DOWN, and kill → the last failed client request. Failed requests during a kill are counted and
     reported (the plan sets no bound for them).
   - *Tightened:* a request "fails" if it was written to a connection and did not get a `2xx`
     response: connect errors, resets, timeouts (5 s), early closes and non-`2xx` all count. The
     client reconnects a keep-alive connection that the server closed while idle before sending on
     it, as a correct HTTP/1.1 client does; the race in which it sends just as the server closes is
     counted as a failure.
   - *Tightened:* zero failures for the whole lame-duck sequence (503 for `drainSeconds`, graceful
     stop, HAProxy removal) and no request is answered by the drained node after its Caddy stops.
2. **Client address.** With PROXY v2 from HAProxy, the backend sees the true client address. A request
   with a forged PROXY header or `X-Forwarded-For` from a source outside `trusted_proxies` is not
   believed, and the listener does not crash on garbage.
   - *Tightened:* "sees" means all of `{http.request.remote.host}` (what `remote_ip` matchers and
     today's Kubernetes allowlist read), `{http.vars.client_ip}` (what `client_ip` matchers read)
     and the access log's `client_ip` show the client's address.
   - *Tightened:* checked on all three listeners (443, 80, the health port), with PROXY v1 and v2
     forgeries and `X-Forwarded-For` forgeries, from an address outside the list.
   - *Tightened:* "does not crash" means the Caddy process keeps its PID and a valid request on the
     same listener succeeds after each garbage case (random bytes, truncated header, bad signature,
     oversized length field, a header that never finishes).
3. **VIP.** keepalived moves the VIP in **≤ 5 s** when the master ingress dies, with VRRP
   authentication on and **no script hooks** (HA-PLAN §10). Failed requests during the move are
   measured and reported.
   - *Tightened:* also measured when only Caddy dies on the master (keepalived still running),
     using keepalived's built-in process tracking, which is not a script.
4. **Reload.** A full Caddy config `POST /load` with **1,000 open keep-alive connections** drops
   **≤ 0.1%** of them (≤ 1 connection), and **no in-flight request fails**.
   - *Tightened:* "dropped" is the strict reading: any of the 1,000 client connections that the
     server side closes or resets because of the reload, measured at the client, whether or not the
     client had a request in flight. Measured directly against Caddy and behind HAProxy.
   - *Tightened:* "in flight" includes slow requests (2 s) that span the reload and new requests sent
     during it.
5. **Health body.** The health endpoint's body is the same size in every state and contains no
   version, hostname, address or topology.
   - *Tightened:* response headers are checked too; anything in them that names a version or the
     node is reported.

Also reported: the probe source addresses HAProxy uses and what `trusted_proxies` must list; whether
the `proxy_protocol` listener wrapper and `trusted_proxies` interact correctly with Host-based
routing; the exact Caddy JSON; a recipe sketch for HAProxy and for keepalived; which health and
lame-duck design was prototyped (W8 builds it).

## Fallback if it fails

Per balancer: documented as unsupported (HA-PLAN §4 W2 table).

## Environment and method

OrbStack Docker on this Mac (arm64), one bridge network, every container named `yoal-w0-s9-*`, no
host ports published, no cloud resource.

- Three ingress containers running the pinned Caddy build, with the config rendered by the real
  `compileCaddyConfig` plus the S9 prototype pieces; keepalived in the first two.
- A tiny upstream app (Bun, release pin 1.4.4), an HAProxy LTS container, and a Bun load generator
  that records every request outcome with a timestamp.
- An "attacker" container on the same segment, outside `trusted_proxies`.

One command runs everything, prints the numbers and removes every container, network and image it
created: `./run.sh`.

---

## Results (2026-11-20)

The numbers, verdicts and environment are in [docs/SPIKES.md](../../docs/SPIKES.md), section
"S9 — Ingress behind a load balancer: HAProxy and keepalived". This section records what the rig
prototyped, so W8 can build it.

### Design prototyped (W8 builds this)

- **Health endpoint: state files plus Caddy's `file` matcher, no reload to flip.** The agent owns
  `/run/yoal/health/` and writes `ready` (routes converged, releases on disk, certificates loaded)
  and `drain` (lame duck). A terminal route at the front of every server answers
  `GET /.well-known/yoal/health`: `503 draining` if `drain` exists, else `503 notready` if `ready`
  is missing, else `200 ok`. Every body is 16 bytes (one word, space-padded, newline);
  `Server` is deleted. The route sits on `:443`, on `:80` (ahead of the redirect) and on a dedicated
  plain-HTTP server (`yoal_health`, rig port 8099; the port is still to be reserved). Caddy stats
  the file per probe, so flipping state costs no reload and survives an agent crash. The rejected
  alternative, a `static_response` the agent rewrites, costs a full `POST /load` per flip, which
  closes every client keep-alive behind an L4 balancer (criterion 4).
- **Lame duck:** touch `drain` → wait `drainSeconds` (20 s) → admin `POST /stop` (graceful,
  `grace_period` 10 s on `apps.http`). While draining, a second non-terminal route sets
  `Connection: close` on every response so keep-alive clients leave before the stop. Both variants
  (with and without `Connection: close`) had zero failures behind HAProxy; keep `Connection: close`,
  because it is what drains an L4 balancer's existing sessions (a DOWN server keeps its sessions).
- **Client address:** `ingress.trustedProxies` renders the `proxy_protocol` listener wrapper with
  `allow: trustedProxies`, `fallback_policy: ignore` (a header from anyone else is read and
  discarded; a connection without a header is accepted, so probes and direct or VIP clients work),
  before the `tls` wrapper on `:443`, and on `:80` and the health server; plus server
  `trusted_proxies` (static, same list), `client_ip_headers: ["X-Forwarded-For"]`,
  `trusted_proxies_strict: 1`. Allowlists must match `client_ip` (H19); `remote_ip` (today's
  Kubernetes allowlist, `apps/agent/src/caddy-config.ts:230`) is right only behind PROXY protocol.
- **`@id` must be unique across the whole config**, so the health route needs one id per server.
  `caddy validate` does not catch a duplicate; `caddy run` and `POST /load` refuse it.
- `render.ts` `applyIngressPrototype()` is the exact JSON; it is applied after the real
  `compileCaddyConfig()`.

### Recipe sketch: HAProxy (generated as `tmp/conf/haproxy.cfg`)

```haproxy
backend be_tls                                # L4: TLS passes through (NLB / Azure LB / Hetzner LB shape)
  mode tcp
  balance leastconn
  option httpchk
  http-check send meth GET uri /.well-known/yoal/health
  http-check expect status 200
  default-server send-proxy-v2               # not on-marked-down shutdown-sessions (resets drained requests)
  server ing-a 10.0.0.21:443 check port 8099 inter 5s fall 2 rise 2   # fastinter 1s should cut removal to ~8 s (untested)
  timeout check 2s                            # (in defaults) worst-case removal ≈ inter + 2×timeout + inter ≈ 14 s

backend be_http                               # L7: HAProxy keeps client keep-alives across Caddy reloads
  mode http
  http-reuse safe
  retry-on conn-failure empty-response response-timeout
  default-server send-proxy-v2 ssl verify none sni req.hdr(host)
  server ing-a 10.0.0.21:443 check port 8099 inter 5s fall 2 rise 2
```

Probe: plain HTTP to the dedicated port, from HAProxy's own address, without a PROXY header.
`trustedProxies` lists the addresses that **send** PROXY headers: each HAProxy's source address.
Probe sources need not be listed. Prefer L7 (`mode http`) when Yoal reloads often: it was the only
path with zero dropped client connections on a config change.

### Recipe sketch: keepalived (`vip` driver; generated as `tmp/conf/keepalived-a.conf`)

```
vrrp_instance yoal_ingress {
  state MASTER | BACKUP; interface eth0; virtual_router_id 59; priority 150 | 100; advert_int 1
  authentication { auth_type PASS; auth_pass <8 chars> }   # VRRPv2 PASS is cleartext on the segment
  virtual_ipaddress { <vip>/24 dev eth0 }
  track_file { yoal_ingress }                               # no vrrp_script, no notify (HA-PLAN §10)
}
track_file yoal_ingress { file /run/yoal/health/vrrp; weight 0; init_file 0 overwrite }
```

Debian 13's keepalived 2.3.3 is built without `track_process`, so nothing script-free notices that
Caddy died unless the agent (through a fixed helper verb) writes a non-zero value to the track
file. The same file is the VIP's lame duck: `drain` for a few seconds, then write `1`. Consider
`nopreempt` (both nodes `BACKUP`): the measured fail-back reset in-flight requests (not tested).

### Deviations from the brief and plan

- The ingress image is Debian 13, not Alpine: Alpine's keepalived has no `track_process`. Debian's has
  none either, so criterion 3's tightened "only Caddy dies" case was run twice: undetected (no tracking
  exists) and with the agent's `track_file` write simulated by the rig 1 s after the kill.
- Caddy is built as `release.yml` builds it; `GOTOOLCHAIN=auto` resolved Go 1.24 to go1.26.0 because
  Caddy 2.11.8's `go.mod` asks for it (the release runner's `setup-go` does the same).
- Certificates come from Caddy's internal CA, not ACME (no DNS, no money); H20/S4 own real certificates.
- The health port (8099) is free in `PLATFORM_HOST_PORTS` but not reserved; W8 reserves one.
- Criterion 1 measures removal for `docker kill`, which the bridge reports as host-unreachable within
  seconds; a powered-off host is silent. DOWN times are unaffected (checks time out at 2 s either way).

---

## Cloud: Hetzner Load Balancer (question, criteria and fallback; written before any cloud code)

The cloud half of S9 (HA-PLAN §4 W2 S9; §1.2 row 1). Azure LB and AWS NLB are **not run** (no
credentials). Spend approved by the owner: **€2 total**; the rig reads live prices first and aborts
if 1 LB11 + 3 of the cheapest Debian 13 server type in one location for 3 h would cost more.

### Question

Behind a real Hetzner Load Balancer (LB11, `tcp` service on 443 with TLS passthrough to the same
pinned Caddy build and the same `applyIngressPrototype()` JSON as the local half; targets on a
private network, `use_private_ip`), does a Yoal ingress set meet the S9 targets?

### Pass criteria (from the plan and the local half; tightened where marked, never loosened)

1. **Killed node out of rotation in ≤ 15 s.** The LB health check targets the plain health port
   (`http`, `GET /.well-known/yoal/health`, expect `200`) with the **tightest interval, timeout and
   retries the Hetzner API accepts**; the values are recorded. Load: 200 req/s from this Mac to the
   LB's public IP, half on 20 keep-alive connections, half on a new connection each.
   - *Tightened (as local):* measured as kill → the LB API reports the target `unhealthy`, **and**
     kill → the last failed client request; both ≤ 15 s. Failed requests are counted and reported.
   - *Tightened:* two kill shapes: Caddy SIGKILLed (the kernel answers with resets) and a **silent**
     death (the server powered off through the API, or all inbound traffic dropped), which the local
     half could not do.
2. **Lame duck with zero failed requests.** `drain` file → `drainSeconds` (20 s) → admin
   `POST /stop`, at 200 req/s through the LB: **zero** failed requests (same failure definition as
   local: written and no `2xx`, 5 s timeout), and no request answered by the node after its Caddy
   stopped.
3. **Client address with Hetzner's `proxyprotocol`.** Through the LB, `{http.request.remote.host}`,
   `{http.vars.client_ip}` and the access log's `client_ip` all show this Mac's public address, with
   `trusted_proxies` and the wrapper's `allow` listing only the LB's private-network address. A
   forged PROXY v2 header or `X-Forwarded-For` sent straight to a node's public address (outside the
   list), or smuggled through the LB, is not believed.
   - *Reported:* the source addresses Hetzner uses for health probes and for proxied traffic, whether
     the probes carry a PROXY header, and what `trusted_proxies` must list.
4. **Reload under 1,000 keep-alive connections.** A changed-config `POST /load` on every target,
   with 1,000 idle TLS keep-alive connections held through the LB plus 50 slow (2 s) requests and
   20 new requests/s: **≤ 0.1%** (≤ 1) connections dropped, and **no in-flight request fails**.
   Same strict "dropped" reading as local (any server-side close seen by the client).
   - *Added:* also measured through a Hetzner `http` (L7) service, since the local half found only
     an L7 balancer hides Caddy's idle closes.

### Fallback if it fails

Per HA-PLAN §4 W2: the Hetzner LB is documented as unsupported for the failed property (for
criterion 4, recorded against the plan's choice already raised by the local half).
