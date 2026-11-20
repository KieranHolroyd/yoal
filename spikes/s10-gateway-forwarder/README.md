# S10 — container reaches the forwarder on the gateway address

Spike S10 of docs/HA-PLAN.md (§4 W2, H24), closing CLUSTERING §15.2 S1 and §17 Q7 / HA-PLAN O2.
Run by the CLUSTERING §15.1 rules: this question, its pass criteria and the fallback were committed
before any rig code.

## Question

Can an app in a Podman container on the network Yoal gives workloads (`yoal-workloads` or
`yoal-org-<id>`, `apps/helper/src/units.ts`) reach the agent's endpoint forwarder
(`apps/agent/src/endpoints.ts`) when that forwarder also listens on the node's container gateway
address, with `AddHost=db-<id>:<gateway>` in the Quadlet unit, so that `db-<id>:<port>` works
wherever the database runs? Is that path stable across forwarder and config reloads? Does it settle
`caddy-l4` versus the Bun forwarder for good?

## Pass criteria (from HA-PLAN §4 W2 S10 and CLUSTERING §15.2 S1; none loosened)

(a) **Reachability, both sides.**
- A container on the workload network connects to `db-<id>:<port>` through `AddHost=` and the
  gateway address, and runs a Postgres query against a real Postgres 18.
- The same port is refused, or its traffic dropped by the nftables rule Yoal would write, from:
  a container on a *different* org network; a non-workload host process (a host process that is
  neither the forwarder nor root, connecting to the gateway address); and from outside the host.

(b) **S1's criteria on this path** (gateway address, container client, real Postgres 18 upstream):
- 0 unexpected resets in 100,000 short connections;
- all 50 idle Postgres connections survive a route edit or reload for another service (checked
  after every reload, not only once);
- p99 added latency ≤ 2 ms against a direct connection to the same Postgres;
- forwarder RSS ≤ 40 MB at 200 routes;
- fd count flat (no growth trend across the soak).

(c) **Soak.** Reloads every 60 s with (b) checked continuously. The plan asks for 24 h; this lane
runs at least 2 h and reports the duration honestly. Anything short of 24 h leaves the full soak
owed.

(d) **Rootless details, recorded as facts.** pasta versus slirp4netns; whether the gateway address
is stable across Podman and network restarts; what happens to a listener bound to the gateway
address when the network (and its bridge) is removed and recreated.

Measured for the Bun forwarder (the repo's code, as-is, plus the minimal prototype change to also
bind the gateway address) and, side by side, `caddy-l4` built on the pinned Caddy (2.11.8, as
`.github/workflows/release.yml` builds it).

**Tightening (not a loosening):** Yoal's Quadlets are system units in `/etc/containers/systemd`
with `UserNS=auto` (root Podman, unprivileged user namespaces), not per-user rootless Podman. The
rig tests both: the mode Yoal runs, for the verdict, and per-user rootless Podman (pasta and
slirp4netns), for (d).

## Fallback if it fails

A host-network sidecar per attached container (HA-PLAN §4 W2 table).

## Environment

One Debian 13 Lima VM `yoal-w0-s10` (VZ, arm64), Podman from Debian, Postgres 18 in a container,
Bun at the release pin (1.4.4). The rig provisions the VM, runs everything, prints the numbers and
deletes the VM.
