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
