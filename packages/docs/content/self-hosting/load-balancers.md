---
title: Load balancers
description: Put several ingress nodes behind Azure Load Balancer, AWS NLB, Hetzner, HAProxy, Cloudflare, Traffic Manager or a floating IP, with probe settings for each.
---

When several nodes have the ingress role, a load balancer in front of them decides which ones get traffic. Yoal does not call the balancer's API. Every ingress answers a health endpoint, and the balancer probes it. This page gives the probe path, port and timings for each balancer, whether it needs PROXY protocol, and the matching Yoal settings.

> [!NOTE]
> Serving from several ingress nodes needs `YOAL_FEATURE_INGRESS_SET=1` and `YOAL_FEATURE_STEERING=1` in the control plane's environment (see [configuration](/self-hosting/configuration)). Both are off by default while they are tested on multi-node fleets. With them off, only the first ingress serves sites, and no node answers the health endpoint.

## What every balancer needs

**The health endpoint.** Every ingress answers `GET /.well-known/yoal/health` on a plain HTTP port, **8099** by default, and on 80 and 443. It answers for any `Host`.

- `200` when Caddy is up, routes have converged, every release is present and certificates are loaded.
- `503` when any of those is false, and while the node drains.
- The body is the same small size in every state and says nothing about the fleet.

Probe the plain port. It needs no TLS, no SNI and no PROXY header. A probe on 443 must send SNI for a real host, because Caddy has no default certificate.

**Out of rotation in 15 seconds.** Yoal's target is that a failed ingress stops getting new connections within 15 seconds. Choose an interval and failure count where interval × failures, plus one probe timeout, stays under 15 seconds. Five seconds and two failures is the usual answer.

**Drain.** When a node drains (an update, a role change, an operator stop), its health endpoint answers `503` for `ingress.drainSeconds` (20 by default) while it keeps serving. Every response in that window has `Connection: close`. Then Caddy stops. The balancer must mark the node down before the drain ends, so `drainSeconds` must be longer than the balancer's removal time. Yoal refuses a value under 15 with the `external-lb` driver.

**Client addresses.** Access rules and logs need the real client address. How Yoal gets it depends on two settings:

| `ingress` settings | Yoal reads the client address from | Use when |
|---|---|---|
| `proxyProtocol: "v2"` (or `"v1"`), `trustedProxies: [<balancer>]` | the PROXY header, accepted only from `trustedProxies` | The balancer replaces the source address and can send a PROXY header (Hetzner, HAProxy in either mode) |
| `proxyProtocol: "off"`, `trustedProxies: [<balancer>]` | `X-Forwarded-For`, believed only from `trustedProxies` | The balancer ends HTTP itself and cannot send a PROXY header (Cloudflare) |
| both unset | the connection's source address | The balancer keeps the client's source address (Azure Load Balancer, AWS NLB instance targets, a floating IP) |

`trustedProxies` lists the addresses that **send** the header, not the probe sources. Keep it as narrow as the balancers themselves: a header from any other source is read and ignored.

**Set them** in **Settings → Clustering**, or over the REST API with a platform admin key:

```sh
curl -X PATCH https://control.example.com/api/v1/cluster/config \
  -H "Authorization: Bearer $YOAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "steering": { "driver": "external-lb" },
    "ingress": { "proxyProtocol": "v2", "trustedProxies": ["10.0.0.5/32"], "drainSeconds": 20 }
  }'
```

`ingress.healthPort` changes the plain port. It must not be 80 or 443.

**Where the numbers come from.** "Tested" means Yoal's balancer spike, S9, measured that shape: HAProxy and keepalived in a lab, and the Hetzner Load Balancer on real servers. "Not yet tested" means the values follow from the provider's settings and nobody has measured them with Yoal.

## Summary

| Balancer | Probe | Interval, failures | PROXY protocol | Removal | Source |
|---|---|---|---|---|---|
| Azure Load Balancer | HTTP 8099 | 5 s, 2 | No | About 10 s | Not yet tested |
| AWS NLB | HTTP 8099 | 5 s, 2 | No (instance targets) | About 10–12 s | Not yet tested |
| Hetzner Load Balancer | HTTP 8099 | 3 s, 1 retry, 1 s timeout | Yes | 4.6–7.9 s for a dead server | Tested (S9) |
| HAProxy | HTTP 8099 | 5 s, 2 (`fall 2`) | Yes (`v2`), in both modes | 9–14 s | Tested (S9) |
| Cloudflare proxied DNS | Yoal probes 443 | 45 s hold-down | No | About a minute | Not yet tested |
| Cloudflare Load Balancing | HTTP 8099 | Your plan's shortest | No | Depends on plan | Not yet tested |
| Azure Traffic Manager | HTTP 80, through the regional balancer | 10 s, 1 | No | Minutes, by DNS TTL | Not yet tested |
| keepalived floating IP | Yoal probes, VRRP | 1 s adverts | No | 2.75–3.36 s for a dead node | Tested (S9) |

## L4 balancers and config reloads

Every balancer here except HAProxy in `mode http` and Cloudflare passes TCP straight through. When an ingress loads a changed configuration, Caddy closes its idle keep-alive connections. Behind a TCP balancer those closes reach the client. In the lab no in-flight request failed. On the Hetzner Load Balancer, over real internet latency, 1 to 3 requests sent on brand-new connections at the moment of the reload failed. An identical configuration is never reloaded, so this happens only when routes, certificates or releases change. A balancer that ends HTTP itself keeps the client side open and hides the closes.

## Azure Load Balancer

A Standard Load Balancer passes TCP through and keeps the client's source address, so Yoal needs neither PROXY protocol nor trusted proxies. Probes come from `168.63.129.16`; Azure's default network security rules allow them.

- Probe: HTTP, port 8099, path `/.well-known/yoal/health`.
- Interval 5 seconds (Azure's minimum), probe threshold 2.
- Rules: TCP 443 and 80, the same port on the backend.
- Yoal: `"proxyProtocol": "off"`, `"trustedProxies": []`.

```text
resource "azurerm_lb_probe" "health" {
  name                = "yoal-health"
  loadbalancer_id     = azurerm_lb.yoal.id
  protocol            = "Http"
  port                = 8099
  request_path        = "/.well-known/yoal/health"
  interval_in_seconds = 5
  probe_threshold     = 2
}

resource "azurerm_lb_rule" "https" {
  name                           = "https"
  loadbalancer_id                = azurerm_lb.yoal.id
  protocol                       = "Tcp"
  frontend_port                  = 443
  backend_port                   = 443
  frontend_ip_configuration_name = "public"
  backend_address_pool_ids       = [azurerm_lb_backend_address_pool.ingress.id]
  probe_id                       = azurerm_lb_probe.health.id
  disable_outbound_snat          = true
  tcp_reset_enabled              = true
}
```

Not yet tested. Two failed probes 5 seconds apart remove a node that answers `503` or refuses connections in about 10 seconds. How long Azure waits on a node that stops answering at all has not been measured.

## AWS Network Load Balancer

With instance targets and client IP preservation (the default for instance targets), the NLB passes the client's address through, so Yoal needs no trusted proxies. The NLB's health checks come from its own addresses inside the VPC: allow port 8099 from the VPC range.

- Target groups: TCP 443 and 80, target type `instance`.
- Health check: HTTP, port 8099, path `/.well-known/yoal/health`, matcher `200`.
- Interval 5 seconds, timeout 2 seconds, unhealthy threshold 2, healthy threshold 2.
- Deregistration delay: 20 seconds, the same as `drainSeconds`.
- Yoal: `"proxyProtocol": "off"`, `"trustedProxies": []`. With IP targets, turn on `proxy_protocol_v2` and set `"proxyProtocol": "v2"` with the subnets in `trustedProxies`.

```text
resource "aws_lb_target_group" "https" {
  name                 = "yoal-https"
  port                 = 443
  protocol             = "TCP"
  vpc_id               = aws_vpc.yoal.id
  target_type          = "instance"
  preserve_client_ip   = true
  deregistration_delay = 20

  health_check {
    protocol            = "HTTP"
    port                = "8099"
    path                = "/.well-known/yoal/health"
    matcher             = "200"
    interval            = 5
    timeout             = 2
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
}
```

Not yet tested.

## Hetzner Load Balancer

The Hetzner Load Balancer reaches the nodes over a private network and replaces the source address, so use PROXY protocol. Health probes and proxied connections both come from the balancer's private address, and probes carry no PROXY header.

- Attach the balancer to the nodes' private network at a fixed address, and add targets with `use_private_ip`.
- Services: `tcp` 443 → 443 and 80 → 80, with `proxyprotocol` on and `least_connections`. Only the 443 service was tested; PROXY protocol on port 80 is not yet tested.
- Health check: `http`, port 8099, path `/.well-known/yoal/health`, status `200`, interval 3 seconds, timeout 1 second, retries 1. These are the lowest values Hetzner's API accepts.
- Yoal: `"proxyProtocol": "v2"`, `"trustedProxies": ["<balancer private address>/32"]`.

```text
resource "hcloud_load_balancer_service" "https" {
  load_balancer_id = hcloud_load_balancer.yoal.id
  protocol         = "tcp"
  listen_port      = 443
  destination_port = 443
  proxyprotocol    = true

  health_check {
    protocol = "http"
    port     = 8099
    interval = 3
    timeout  = 1
    retries  = 1
    http {
      path         = "/.well-known/yoal/health"
      status_codes = ["200"]
    }
  }
}
```

Set the Yoal settings **before** you turn `proxyprotocol` on. Yoal accepts connections without the header from a trusted address, so this order never breaks traffic; the other order makes Caddy read the header as a broken TLS handshake.

> [!WARNING]
> Between the two steps, Yoal trusts the balancer's address but the balancer sends no PROXY header, so Yoal believes an `X-Forwarded-For` header a client sends through it. Access rules can be bypassed in that window. Run the two steps back to back.

Tested (S9), on an LB11 with three Debian 13 servers: a powered-off server was out of rotation in 4.6–7.9 seconds and a crashed Caddy in at most 4.7 seconds; a drained node finished with 0 failed requests in 10 of 10 runs; the client address was correct and forged headers were ignored in every case. Use the `tcp` service: Hetzner's `http` service returned a `502` at a reload in 3 of 7 runs and puts its own address in the connection's source.

## HAProxy

HAProxy works in either mode. `mode http` is the recommended shape: it ends TLS (or re-encrypts), keeps client keep-alives open across Caddy reloads, and met every criterion in the lab.

```text
backend be_ingress
  mode http
  balance leastconn
  option httpchk GET /.well-known/yoal/health
  http-check expect status 200
  default-server check port 8099 inter 5s fall 2 rise 2 send-proxy-v2 ssl verify none sni req.hdr(host)
  timeout check 2s
  option redispatch
  server ing-a 10.0.0.21:443
  server ing-b 10.0.0.22:443
  server ing-c 10.0.0.23:443
```

For TLS pass-through, use `mode tcp` with the same checks and `send-proxy-v2`. Either way, set `"proxyProtocol": "v2"` and list each HAProxy's source address in `trustedProxies`. Do not add `on-marked-down shutdown-sessions`: it reset requests a draining node was still serving.

Tested (S9), HAProxy 3.4: a killed ingress was out of rotation in 9.2–13.3 seconds; a drained node finished with 0 failed requests in 22 of 23 runs (one run stalled on every node for an unexplained reason, starting before the drain); forged PROXY and `X-Forwarded-For` headers from unlisted sources were ignored in 67 of 67 cases.

## Cloudflare proxied DNS

Cloudflare's proxy does not probe your origins. Use the `dns-failover` driver instead of `external-lb`: Yoal probes each ingress on 443 itself and removes a failing node's `A` record from the platform host, the sites domain and its wildcard. It never removes the last healthy record.

```dotenv
YOAL_CLOUDFLARE_API_TOKEN=...
YOAL_CLOUDFLARE_ZONE_NAME=example.com
YOAL_DNS_FAILOVER_PROXIED=true
YOAL_DNS_FAILOVER_TTL=60
```

Set these in the control plane's environment, then set `"steering": { "driver": "dns-failover" }`. Use these names only for Yoal: the driver removes any other `A` or `AAAA` record it finds at them.

Cloudflare sends the client address in `X-Forwarded-For`. Set `"trustedProxies"` to Cloudflare's published IP ranges (https://www.cloudflare.com/ips/), and `"proxyProtocol": "off"`.

This does not meet the 15-second target. A node is removed only after its probe has failed for 45 seconds (90 seconds when no probe from another zone agrees), so plan on about a minute. Not yet tested end to end.

## Cloudflare Load Balancing

Cloudflare Load Balancing probes each origin itself, so it works with the `external-lb` driver.

- Monitor: HTTP, port 8099, path `/.well-known/yoal/health`, expected code `200`, with the shortest interval your plan allows.
- Pool: one origin per ingress node, at its public address. Port 8099 must be reachable from Cloudflare's monitors.
- Yoal: `"proxyProtocol": "off"`, and Cloudflare's published IP ranges in `trustedProxies`.

Cloudflare's shortest monitor interval depends on your plan. If interval × retries comes to more than about 15 seconds, this balancer does not meet the target. Not yet tested.

## Azure Traffic Manager in front of a regional balancer

Traffic Manager answers DNS, so it fails over between regions, not between nodes. Put an Azure Load Balancer (above) in each region; it removes a failed node within the region. Traffic Manager sends clients to another region only when a whole region's balancer stops answering.

- Endpoints: each region's balancer public IP.
- Monitor: HTTP, port 80, path `/.well-known/yoal/health`, with a custom `Host` header of your platform host. Through the balancer, it answers `200` while any ingress in the region is healthy.
- Fast probing: interval 10 seconds, tolerated failures 1, timeout 5 seconds. Keep the DNS TTL short (for example 30 seconds).
- Yoal: the regional balancer's settings. Traffic Manager does not carry traffic, so it changes nothing for client addresses.

```text
resource "azurerm_traffic_manager_profile" "yoal" {
  name                   = "yoal"
  resource_group_name    = azurerm_resource_group.yoal.name
  traffic_routing_method = "Priority"

  dns_config {
    relative_name = "yoal-example"
    ttl           = 30
  }

  monitor_config {
    protocol                     = "HTTP"
    port                         = 80
    path                         = "/.well-known/yoal/health"
    interval_in_seconds          = 10
    timeout_in_seconds           = 5
    tolerated_number_of_failures = 1
    custom_header {
      name  = "host"
      value = "control.example.com"
    }
  }
}
```

Expect a region failover to take minutes, mostly DNS caching. Not yet tested.

## keepalived floating IP

For machines on one layer-2 network (bare metal, a homelab), keepalived moves one floating address between ingress nodes by VRRP. Use the `vip` driver: Yoal installs and configures keepalived through its helper, probes the ingress nodes itself and lowers the priority of one that is failing or draining. No balancer probes anything. Most cloud networks do not carry VRRP; use the cloud's balancer there.

```dotenv
YOAL_VIP_ADDRESS=192.0.2.10
YOAL_VIP_INTERFACE=eth0
YOAL_VIP_ROUTER_ID=51
YOAL_VIP_AUTH_PASS=change-me
```

Set these in the control plane's environment, then set `"steering": { "driver": "vip" }`. `YOAL_VIP_ROUTER_ID` must be unique on the network, and `YOAL_VIP_AUTH_PASS` is 1 to 8 characters. VRRP sends that password in clear text on the segment, so it only stops accidents, not attackers.

The client connects straight to the node that holds the address, so Yoal needs neither PROXY protocol nor trusted proxies.

Tested (S9), keepalived 2.3: when the node holding the address died, the backup answered 2.75 and 3.36 seconds later; 14 and 21 requests in flight at that moment failed. A drained node handed the address over with 0 failed requests. When the original node came back it took the address back and reset about 20 in-flight requests. keepalived alone does not notice when only Caddy dies; Yoal's probe does, which has not been timed end to end.

## Terraform modules

The Yoal repository has Terraform modules under `deploy/terraform` for Azure, Hetzner and AWS, with the balancer settings on this page. Each creates four machines across zones, the balancer, a versioned bucket and, on Azure and AWS, optional DNS records. The machines install Yoal with cloud-init, which runs the same installer and `node.sh` join line you would type. A join token lasts an hour and works once, so you create the joining machines in a second `terraform apply`, after you create one token per node under **Nodes → Enroll node**.

> [!NOTE]
> Not available yet: installer flags for a node's zone and roles. Set them under **Nodes → Edit node** after each node joins.
