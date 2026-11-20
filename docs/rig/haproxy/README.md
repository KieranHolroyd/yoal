# HAProxy recipe for the `external-lb` driver

One balancer recipe, written from the S9 measurements in
[docs/SPIKES.md](../../SPIKES.md#s9--ingress-behind-a-load-balancer-haproxy-and-keepalived-2026-11-20)
and the rig in [`spikes/s9-balancers`](../../../spikes/s9-balancers/README.md). The same recipe shape
works for Azure Load Balancer, AWS NLB, GCP Load Balancing, Hetzner Load Balancer, F5 and Cloudflare
Load Balancing: `external-lb` writes nothing, so every one of them only needs an HTTP probe.

The live lab timing (kill an ingress, drain an ingress, count failed requests) belongs to the lab
lane. This page is the configuration under test, not a second set of numbers.

## What Yoal does

- Serves `GET /.well-known/yoal/health` on `:443` and `:80`, and on the plain HTTP health port
  (default **8099**, `ingress.healthPort` overrides) for L4 balancers. `200` only when Caddy is up,
  routes are converged, every release is present and certificates are loaded; otherwise `503` with a
  one-word reason (HA-PLAN H19).
- On a drain (update, role removal, operator stop) answers `503` for `ingress.drainSeconds`
  (default 20 s) while still serving, then stops Caddy gracefully. Every response in that window
  carries `Connection: close`, so keep-alive clients leave before the stop.
- Never calls HAProxy's API. The balancer owns the decision; `yoal ha status` reports the probe
  path, health port and intended serving set so the operator can see the same view.

## Select the driver

The setting is inert until the flag is on:

```sh
# control plane environment
YOAL_FEATURE_STEERING=1
```

```http
PATCH /api/v1/cluster/config
Content-Type: application/json

{
  "steering": { "driver": "external-lb" },
  "ingress": {
    "proxyProtocol": "v2",
    "trustedProxies": ["10.0.0.10/32"],
    "drainSeconds": 20
  }
}
```

`trustedProxies` lists the addresses that **send** the PROXY header (each HAProxy's source address),
not the probe sources. With `proxyProtocol: v2` and an empty list, preflight refuses: Caddy would
not accept the header from the balancer, so every Access rule would read the balancer's address.

## Probe settings that meet the 15 s bound

From S9, on the plain HTTP health port (no TLS, no SNI, no PROXY header):

```haproxy
option httpchk GET /.well-known/yoal/health
http-check expect status 200
default-server check inter 5s fall 2 rise 2
timeout check 2s
```

Worst-case removal = one interval + two check timeouts + one interval ≈ **14 s**, inside the 15 s
bound in HA-PLAN §1.2. `fastinter 1s` is untested; do not shorten `fall` below 2.

The plain port avoids Caddy's no-default-certificate reply on `:443` without SNI, and avoids the
PROXY wrapper on probe connections. If a provider only probes TLS, send SNI for a real host; probe
failures would otherwise be indistinguishable from a certificate problem.

## L7 (recommended) and L4 (cloud passthrough)

```haproxy
# L7: HAProxy terminates or re-encrypts, keeps client keep-alives across Caddy reloads.
frontend fe_https
  bind :443 ssl crt /etc/haproxy/tls.pem alpn h2,http/1.1
  default_backend be_ingress

backend be_ingress
  mode http
  balance leastconn
  option httpchk GET /.well-known/yoal/health
  http-check expect status 200
  default-server check inter 5s fall 2 rise 2 send-proxy-v2 ssl verify none sni req.hdr(host)
  timeout check 2s
  retries 2
  option redispatch
  # Do NOT add `on-marked-down shutdown-sessions`: S9 measured it resetting requests a draining
  # node was still serving.
  server ing-a 10.0.0.21:443
  server ing-b 10.0.0.22:443
  server ing-c 10.0.0.23:443
```

```haproxy
# L4: TLS passes through, the cloud LB / NLB / Azure LB shape.
backend be_ingress_tcp
  mode tcp
  balance leastconn
  option httpchk GET /.well-known/yoal/health
  http-check expect status 200
  default-server check inter 5s fall 2 rise 2 send-proxy-v2
  server ing-a 10.0.0.21:443 check port 8099
  server ing-b 10.0.0.22:443 check port 8099
  server ing-c 10.0.0.23:443 check port 8099
  timeout check 2s
```

S9 found L7 the only path that keeps 1,000 idle keep-alive connections across a config change
(0 dropped); behind L4 every idle connection is closed by Caddy's graceful reload (no in-flight
request failed). Both meet the kill/drain bound. Prefer L7 where the balancer can terminate or
re-encrypt.

## Client addresses in Access rules

| `ingress` setting | `external-lb` capability | HAProxy |
|---|---|---|
| `proxyProtocol: v1` or `v2` | `proxy-protocol` | `send-proxy-v2` (or `send-proxy` for v1); list HAProxy in `trustedProxies` |
| `proxyProtocol: off`, `trustedProxies: [cidr]` | `header` | `option forwardfor`; list HAProxy in `trustedProxies` |
| both unset | `native` | the client address is HAProxy's; only safe for a lab |

`proxyProtocol` is the stronger option: it carries the address before TLS, so `remote_ip` matchers,
the Kubernetes allowlist and the access log all agree. A header from a source outside
`trustedProxies` is read and discarded (S9, 67/67 cases). Never configure a `trustedProxies` range
wider than the balancers that actually send the header.

## Other balancers

- **AWS NLB / Azure Load Balancer / Hetzner LB (TCP mode):** health check `HTTP GET
  /.well-known/yoal/health`, port 8099, interval 5 s, healthy/unhealthy threshold 2, timeout 2 s.
  Enable PROXY protocol v2 on the target group/service and set `ingress.proxyProtocol: v2`; list
  the balancer's source range in `trustedProxies`. L4 caveat above.
- **GCP Load Balancing / Cloudflare Load Balancing / F5 (HTTP mode):** same path, interval 5 s,
  threshold 2. Use `proxyProtocol` only if the balancer supports it; otherwise set
  `trustedProxies` and forward the client header.
- **Cloudflare proxied DNS without Load Balancing:** no health checks, so it cannot remove a dead
  origin. That is `dns-failover`, not this driver.

## Drain sizing

`drainSeconds` must be longer than the balancer takes to mark the node down, or Caddy stops while
HAProxy still sends requests. With `inter 5s fall 2 timeout 2s`, the worst case is ≈14 s; the
default 20 s leaves margin. `external-lb` preflight refuses a value below 15 s.

## Verify

```sh
# 1. The health endpoint answers 200 with the same body in every state (16 bytes).
curl -sS -o /dev/null -w '%{http_code}\n' http://<ingress>:8099/.well-known/yoal/health

# 2. Preflight names every refusal per node.
curl -sS -H "Authorization: Bearer $YOAL_TOKEN" https://<control>/api/v1/cluster/config

# 3. Settings → High availability shows the driver, probe path and intended serving set.
# 4. The lab lane runs the kill/drain timing; this page does not replace it.
```
