# Yoal — Managed Kubernetes

Status: **K0–K6 built 2026-11-18** (planned and grilled the same day; answers in §16). Decisions
D226 (component, machines, placement), D227 (tiers), D228 (identity and the API route), D229
(manifests, routes, attachments), D230 (snapshots, restore), D231 (rollouts, patching) and D232
(multi-node, HA) in [DECISIONS.md](./DECISIONS.md); the other proposals become
D-numbers as they ship. §17 lists what is built and what is not, and the spike results are in
`spikes/k8s/RESULTS.md`.

**Who it is for** (G1): the platform owner, and trusted people in other orgs. Isolation protects
against their mistakes (a chart with a privileged DaemonSet), not against an attacker. The design
keeps room for untrusted tenants (`vm` tier) without building for them yet.

A **Kubernetes cluster** is an org-owned resource that Yoal provisions, runs, upgrades and backs
up, the way it runs a managed database or broker. A user creates one, downloads a kubeconfig, and
uses `kubectl`, Helm or Argo CD against it. Yoal does the lifecycle work, identity, ingress and
backups.

This is a **product Yoal hosts, not a scheduler Yoal uses**. Yoal's own workloads never run on
Kubernetes. The non-goal in DESIGN §1 and the verdict in CLUSTERING §22 stand: Yoal places things
once at deploy time with its own filter-and-score. This plan only adds Kubernetes as something a
tenant can ask for (§14 lists the wording to amend).

It is an **optional install, per node**. A node runs clusters only after an operator installs the
Kubernetes component on it (`--with-kubernetes`, or Nodes → node → Components). The agent then
advertises the `kubernetes` capability. Placement only considers those nodes, and the dashboard's
Kubernetes area stays hidden until at least one node has it.

---

## 0. Summary

| # | What | Why |
|---|---|---|
| K1 | **k3s** is the distribution, pinned by digest per version in a registry in contracts (D61 pattern) | One binary, SQLite (kine) for a single server, embedded etcd for three, CNCF-conformant, and a bundled-manifests directory Yoal can write to. |
| K2 | The Kubernetes **component is installed per node** and advertised as the `kubernetes` capability | Same shape as `process-node` and `functions-python`. Nodes that never asked download nothing. |
| K3 | A cluster runs as **machines**: each k3s server or agent is a container the helper starts under a new `k8s` profile | Several clusters fit on one node, each with its own network namespace, cgroup and data directory. It reuses the managed-service pipeline (DATABASES §2). |
| K4 | **Isolation tiers**: `userns` (privileged k3s inside a per-machine user namespace), `trusted` (privileged; the platform owner's org, plus orgs the owner grants it to, only on nodes dedicated to and bound to that org) and later `vm` (microVM, needs `/dev/kvm`) | Cluster-admin can run privileged pods, so the machine boundary must stop container root being host root (D138). A trusted org's mistake can break only its own Kubernetes node, never your apps or another org's cluster. S1 decides whether `userns` works. |
| K5 | **Single-node clusters first** (K2), then **several agent machines on one node** (K2.5), then multi-node and three-server HA (K6) | Ships a useful cluster without cross-node pod networking. K2.5 lets people test scheduling, drains, taints and DaemonSets cheaply. |
| K6 | Machines **bind nothing public**. The API server publishes on `127.0.0.1:<hostPort>` only (D56) | Every outside path goes through Caddy or the overlay, never a direct bind. |
| K7 | The **API endpoint is an HTTPS route** `<cluster>.k8s.<contentDomain>`, public by default. One extra wildcard certificate, `*.k8s.<contentDomain>`, covers every cluster, and its DNS record is **DNS-only** (grey cloud). Caddy refuses requests without `Authorization: Bearer` (except `/livez`, `/readyz`, `/version`) before proxying, terminates TLS, and re-encrypts to the loopback port | No `caddy-l4` needed. It is the cluster's own listener (D225). Cloudflare's free certificate does not cover a second label and its proxy cuts streams idle for 100 s. The Bearer rule keeps unauthenticated traffic away from the API server. Opt-in IP allowlist, or `private` mode. |
| K8 | **Yoal is the cluster's identity provider.** The API server trusts the platform issuer (CLOUD-IDENTITY §1) for audience `k8s:<clusterId>`. `yoal k8s token` mints 15-minute ES256 tokens | Bearer tokens survive a TLS-terminating proxy, client certificates do not. One identity system, revocable through IAM, audited. |
| K9 | **IAM roles map to Kubernetes groups**: `kubernetes:admin` → `cluster-admin`, `kubernetes:edit` → `edit`, `kubernetes:view` → `view`, through bindings Yoal writes to the auto-deploy manifests | People get cluster access from their Yoal role, with no per-cluster user management. |
| K10 | The **admin certificate is break-glass**: sealed with the org key, used by the agent on loopback, revealed only with `kubernetes:credentials` plus step-up, never over MCP (D58) | Users never need it day to day, and it does not expire when someone leaves. |
| K11 | **Ingress**: the bundled Traefik is kept and published on loopback. Cluster **routes** are Caddy routes to it: single-label `<host>.<contentDomain>` names claimed from the project slug namespace (covered by the existing wildcard, D14), or verified custom domains on on-demand TLS | In-cluster Ingress objects work out of the box, TLS and domains stay Yoal's job, and no per-cluster certificate is ever issued. |
| K12 | **Attachments**: a cluster can attach Yoal databases, brokers and buckets. Yoal writes a Secret into a chosen namespace | Same idea as project attachments, with connection values delivered the Kubernetes way. |
| K13 | **Registry**: machines pull through the node's loopback mirror with a cluster-scoped `image:pull` credential the agent rotates | Private images from Yoal's registry work without `imagePullSecrets`. |
| K14 | **Backups**: datastore snapshots from K2 (SQLite through a helper verb, etcd through `k3s etcd-snapshot`), and Velero for PV data in K5, both to Yoal object storage | Every cluster is restorable to another node from the first phase. |
| K15 | **Upgrades**: patch releases apply automatically in each cluster's **maintenance window** (opt-out per cluster). Minors are manual, one at a time, with deprecated-API warnings at 60 and 30 days, and automatic at end of support. All through a `kubernetes.upgrade` flow: servers one by one, then agents, each drained, rolled back if the API does not come ready | Internet-facing API servers must stay patched. Minors can remove APIs, so a person chooses when, until the version leaves the window. The pinned version set stays bounded. |
| K16 | Machines **count toward node admission and org quotas** (D42, QUOTAS.md), and the kubelet's allocatable is set from the machine's `MemoryMax` | Pods must not be scheduled against host memory the cgroup will not give them. |
| K17 | **Recovery levels**, all supported: (a) manual restore to another node, (b) automatic restore after the node is offline N minutes, behind a lease (K7 phase), (c) three-server HA on embedded etcd across nodes (K6). A single-server SQLite cluster converts to etcd in place (`--cluster-init`) when it is made HA | Fits D107's per-resource levels. Lab clusters never pay for etcd, and a production cluster becomes HA without a migration by hand. |
| K18 | Later: `vm` tier, workload identity (service-account issuer as a federation trust, IAM I17), keyless CI federation in `auth.yaml`, `LoadBalancer` services through Yoal TCP endpoints, a resource browser in the dashboard, agent-pool autoscaling | Recorded so the seams in K3–K17 leave room for them. |
| K19 | **Cluster access keys**: Yoal-managed ServiceAccounts bound to view, edit or admin, listed, rotated and revoked from Yoal, delivered as a static kubeconfig | Argo CD, Lens and SaaS tools need a static kubeconfig. Revoking deletes the ServiceAccount, so a leaked key dies at once, unlike a long-lived JWT. |
| K20 | **MCP works inside clusters with the caller's RBAC**: read tools (`k8s_get`, `k8s_logs`) in K3, `k8s_apply`, `k8s_delete` and `k8s_rollout_restart` in K4. Yoal makes the call with a token minted for the calling principal, audits it, and redacts Secret data | "Ask your agent to deploy to my cluster" works from chat, and no credential ever reaches the agent (D58). |
| K21 | **Persistent data lives in Yoal data services**, attached into the cluster (K12). PVs are `local-path` (scratch, node-local) or `yoal-shared`, an NFS CSI StorageClass on a share (CLUSTERING §5.2) | HA without replicated block storage, consistent with CLUSTERING §22. Cross-node attachments (CLUSTERING C2) become a prerequisite for K6. |
| K22 | A cluster has a **`purpose`**: `lab` or `production`. `production` is refused until K5 ships, and it turns on defaults: the log/metric shipper, the allowlist reminder, conversion to HA | The production label only exists once restore, patching and log history make it honest. |
| K23 | An opt-in **log and metric shipper** (pinned Vector or OTel Collector DaemonSet plus `kube-state-metrics`) pushes to Yoal's ClickHouse store with a cluster-scoped token. On by default for `production`, hidden when the optional store is not installed | Production clusters get log history, search and Yoal alerts without running their own Prometheus or Loki. |
| K24 | A node that runs `trusted` clusters is labelled `kubernetes=dedicated:<org>` by the platform owner and runs nothing else | One dedicated node never holds two orgs' privileged clusters. |
| K25 | Clusters are refused on nodes with the `ingress` or `control` role unless the node is named explicitly | Keeps the edge inside DESIGN's 250 MB platform budget. |

---

## 1. Where things stand

- **Nothing Kubernetes-shaped exists.** No code, no capability, no table. Docs reject Kubernetes as
  Yoal's own orchestrator (DESIGN §1, CLUSTERING §22.2, build-plan README rule 8, FUNCTIONS
  non-goal 8). None of that changes. Those docs need a sentence saying a hosted cluster is
  different (§14).
- **The managed-service pipeline is the template.** A database or broker is a table row, placed by
  a core service (`packages/core/src/databases.ts`, `brokers.ts`), sent to the node as a container
  `WorkloadDesired` with a typed block (`packages/contracts/src/workload.ts`), and rendered by
  `yoal-helper` into a fixed Quadlet (`apps/helper/src/units.ts`, `renderBrokerUnit`). Brokers gate
  placement on the `brokers` capability (`brokers.ts:863`).
- **Optional per-node components have a pattern.** Node.js (D125) is the closest: pinned binary,
  installer step, converge step (`scripts/release/converge.ts`), advertised capability
  (`apps/agent/src/main.ts`, `advertisedCapabilities`) and a placement refusal naming the fix
  (`workloads.ts`, `assertNodeEngineTarget`). FrankenPHP and Node can only be installed over SSH.
  ClickHouse is the one component the dashboard installs, through the platform-config request
  file and the root helper (OPS §3.6).
- **Host networking will need two changes for multi-node.** `apps/helper/src/network.ts` accepts
  only a TCP port list on `wg0` and drops the rest. UDP (flannel) is not representable today.
  Single-node clusters need neither.
- **No virtualisation.** There is no microVM code. Pipelines detect `/dev/kvm` (W14), but neither
  prod node has it (Scaleway and Hetzner Cloud instances), so `vm` cannot be the first tier.
- **Identity is ready.** The platform issuer, discovery, JWKS and ES256 key ring exist
  (CLOUD-IDENTITY §1). A Kubernetes API server can trust it through structured authentication
  configuration.

---

## 2. Distribution (K1)

| Option | Verdict | Reason |
|---|---|---|
| **k3s** | **Chosen** | One binary, runs well in a container (k3d), SQLite for one server and embedded etcd for three, auto-deploys anything in `server/manifests`, bundles CoreDNS, Traefik, local-path and metrics-server, all switchable. |
| k0s | Alternative | Similar footprint. Less proven in containers, and no auto-deploy manifests directory. |
| RKE2 | Rejected for now | Hardened (CIS) but heavier, containerd and etcd always. Revisit as a `hardened` flavour. |
| kubeadm | Rejected | Yoal would own etcd, certificates and add-ons itself. |
| Talos | Rejected | Wants the whole machine (or a VM). A candidate image for the later `vm` tier. |
| vcluster on one shared host cluster | Rejected | Tenants share the host cluster's nodes and kernel through a cluster Yoal must run anyway. |

Versions are a registry in `packages/contracts/src/kubernetes.ts`: the three newest k3s minors,
each pinned to an image digest and an airgap images bundle digest. As with D61, the wire carries a
version and the helper resolves the image. A new minor is a data change, shipped in a release.

---

## 3. The node component (K2)

### 3.1 What installing it does

`scripts/install/kubernetes.ts`, idempotent, same shape as `frankenphp.ts`:

1. **Checks** cgroup v2 with the `cpu`, `memory`, `pids` and `cpuset` controllers delegated, a
   kernel new enough for the chosen tier, and enough memory (refuses below 2 GB host RAM).
2. **Kernel setup**: loads `overlay`, `br_netfilter`, `nf_conntrack` and the iptables/nft modules,
   persisted in `/etc/modules-load.d/yoal-k8s.conf`. Sets `net.ipv4.ip_forward=1`,
   `net.bridge.bridge-nf-call-iptables=1` and higher `fs.inotify.max_user_instances`/`watches` in
   `/etc/sysctl.d/60-yoal-k8s.conf`.
3. **Images**: pulls each pinned `rancher/k3s` image by digest and downloads each airgap bundle
   (digest checked before write, then renamed into place) to `/usr/lib/yoal/k3s/<version>/`.
   Machines mount that directory read-only as `agent/images`, so a cluster never pulls its
   add-ons from the internet.
4. **Tier probe**: runs the S1 test machine once and writes the tiers that work to
   `/usr/lib/yoal/k3s/tiers.json`.
5. Writes `/usr/lib/yoal/k3s/installed` with the version set.

Removing it is refused while any machine is placed on the node. `--purge` also deletes the images
and bundles.

### 3.2 How it is triggered

| Path | How |
|---|---|
| Installer | `--with-kubernetes` / `YOAL_INSTALL_KUBERNETES=1`, also on `join-worker`. A failure is a warning, as with PHP. |
| On an installed node | `sudo bun …/scripts/install/kubernetes.ts [--remove [--purge]]` |
| Dashboard | **Nodes → node → Components → Kubernetes → Install/Remove**, platform owner only, with step-up (STEP-UP.md). It queues a node task. The helper runs the fixed verb `POST /v1/components/kubernetes {action: install\|remove, purge}`, which runs the same script. No argument names a path, image or version. |

The dashboard path makes Kubernetes the second component installable without SSH, after
ClickHouse. The same `/v1/components/<name>` verb can later take PHP and Node, so it is worth
building generically (one allowlist of component names).

### 3.3 Convergence and capability

- `scripts/release/converge.ts` updates only nodes with the `installed` marker: it adds newly
  pinned versions and removes versions no machine uses and the registry no longer lists.
- The agent advertises `kubernetes` while the marker exists and the prerequisites still pass, plus
  one capability per working tier: `kubernetes-userns`, `kubernetes-trusted` and later
  `kubernetes-vm`. The heartbeat carries the installed version set.
- Placement filters on these (brokers pattern). Naming a node without them is refused with "install
  the Kubernetes component on <node> first" (or "update its agent first" for an old agent).
- Nodes with the `ingress` or `control` role are excluded unless the placement names them
  explicitly. A k3s server would push the edge past DESIGN's 250 MB platform budget.

---

## 4. Model

### 4.1 Tables (migration `0116_kubernetes.sql`, check the number when building)

| Table | Purpose |
|---|---|
| `k8s_clusters` | One row per cluster: org, name, id `kc_<32 hex>`, version, isolation tier, HA level, API access mode and allowlist, status, sealed CA, sealed admin cert and key, sealed server join token, generation, settings (add-ons on/off), soft-delete columns. |
| `k8s_machines` | One row per server or agent: id `km_<32 hex>` (also the node workload id), cluster, role (`server`, `agent`, or `server+agent` for a single-node cluster), node, host ports, memory, CPU, storage target (D169), status, restart count. |
| `k8s_routes` | Hostname → cluster. Platform hostnames under `*.<cluster>.k8s.<contentDomain>` or a verified custom domain (same verification as project domains). |
| `k8s_attachments` | Cluster ↔ database, broker or bucket, with target namespace and Secret name. |
| `k8s_access_keys` | Access keys (K19): cluster, name, role, creator, expiry, revoked at. The token is never stored after it is returned. |
| `k8s_backups` | Datastore snapshots: kind (`sqlite`, `etcd`), object key, size, status, version, created by. |
| `k8s_log_events` | Lifecycle and runtime log lines (same shape as `broker_log_events`). |

- Names follow slug rules (3–40, `[a-z0-9-]`, no `--`) and are unique per org.
- `k8s_clusters.version` has no CHECK constraint, so a new minor never needs a migration (the lesson
  of 0028).
- Status uses the workload vocabulary, driven by heartbeats, plus a `degraded` state when the API
  answers but a node is `NotReady`.

### 4.2 Sizes

| Setting | Default | Minimum | Notes |
|---|---|---|---|
| Machine memory | 2048 MB | 1024 MB | The server alone idles at several hundred MB. S2 measures it. |
| Machine CPU | 1 vCPU | 0.5 | `CPUQuota`. |
| Datastore | SQLite (L0) | | etcd once HA lands. |
| Storage target | `kubernetes` storage kind | | New kind in Settings → Storage, default `fast`. |

Machines count toward node admission (D42) through a `reservedByNode()` on the new service, added
next to databases, storage and brokers in `workloads.ts`. They also count toward the org memory
quota and a new `maxClusters` org limit.

---

## 5. Runtime: machines and isolation (K3, K4, K16)

### 5.1 The `k8s` helper profile

The control plane sends each machine as a container `WorkloadDesired` with
`kubernetes: { clusterId, role, version, tier, ports, settings }`. The helper keeps its own
registry and never takes an image, mount, flag or manifest from the wire:

- **Image** from the version registry: `rancher/k3s@sha256:…`.
- **Exec**: `k3s server` (or `agent`) with flags the helper renders. They include
  `--disable servicelb`, `--write-kubeconfig-mode 0600`, `--tls-san <cluster host>`,
  `--node-name <machine id>`, `--kube-apiserver-arg=authentication-config=/etc/yoal/k8s/auth.yaml`,
  `--kube-apiserver-arg=anonymous-auth=false`, and kubelet `system-reserved`/`eviction-hard`
  values computed from `MemoryMax` so allocatable stays inside the cgroup (K16).
- **Mounts**: data at `<storage>/yoal/<machineId>` → `/var/lib/rancher/k3s`. Airgap bundle
  read-only. Helper-written files (`auth.yaml`, `registries.yaml`, the RBAC and attachment
  manifests in §6–§8) under `/run/yoal-workloads/<id>/`, mounted read-only.
- **Ports**: `PublishPort=127.0.0.1:<apiPort>:6443` and `127.0.0.1:<ingressPort>:80` from a new
  range (16443–16942 and 17080–17579). Nothing listens on a public or `wg0` address until
  multi-node (§10).
- **Limits**: `MemoryMax`, `CPUQuota`, `TasksMax`, `Slice=yoal-workloads.slice`.
- **Network**: the machine joins `yoal-workloads.network` with alias `k8s-<hex>`, so attachments
  on the same node resolve (§8). Pod and service CIDRs are the k3s defaults (10.42/16, 10.43/16).
  They live inside the machine's network namespace and do not clash with the overlay (10.47) or
  Podman (10.88, 10.89).

### 5.2 Isolation tiers

A cluster admin can run a privileged pod with `hostPath: /`. The machine boundary is therefore the
real security boundary, and D138 says container root must never be host root.

| Tier | Machine runs as | Host exposure if a cluster admin escapes the pod | Who can choose it | Availability |
|---|---|---|---|---|
| `userns` (default, if S1 passes) | Privileged container inside `UserNS=auto:size=65536` with cgroup namespace, as kind and k3d run rootless | Root in the machine maps to an unprivileged host uid range. Escape means the kernel, not the namespace. | Any org with `kubernetes:create` | Nodes advertising `kubernetes-userns` |
| `trusted` | Privileged rootful container, no user namespace | **Host root on that node.** | The platform owner's org, and orgs the platform owner grants it to (`orgs.kubernetes_trusted`, audited, with the warning shown at grant time) | Nodes advertising `kubernetes-trusted` **and** labelled `kubernetes=dedicated:<org>` for that org |
| `vm` (K18) | A cloud-hypervisor or Firecracker microVM per machine | A VM boundary | Any org | Nodes with `/dev/kvm` (none of the current fleet) |

A node labelled `kubernetes=dedicated:<org>` runs nothing but that org's Kubernetes machines
(`kubernetes=dedicated` with no org means the platform owner's org). Placement refuses every other
workload there, and refuses another org's `trusted` machines. `userns` machines of the same org may
share it. The label is set by the platform owner, never on first use, so a trusted org's mistake can
break only its own Kubernetes node: never your apps, and never another org's cluster state.

If S1 fails, `trusted` ships alone and the create flow says plainly that cluster admins can become
root on that node.

### 5.3 Health

The agent probes `GET /readyz` on the loopback API port with the admin certificate, and counts
`NotReady` nodes from `/api/v1/nodes`. Five restarts mark a machine failed, as for brokers.

---

## 6. Access: endpoint, identity and RBAC (K6–K10)

### 6.1 Endpoint (K7)

| API access mode | Path |
|---|---|
| `public` (default) | `https://<name>-<org8>.k8s.<contentDomain>` is a Caddy route on the ingress nodes → overlay → the machine's node → `127.0.0.1:<apiPort>`, re-encrypting to the API server with the cluster CA pinned. Optional CIDR allowlist enforced in Caddy. |
| `private` | No public route. Reachable over the overlay from Yoal nodes, and from a laptop through `yoal k8s proxy <cluster>`, which tunnels through the control plane's authenticated WebSocket like the console (D127). |

- **Certificate.** One wildcard, `*.k8s.<contentDomain>`, issued once over the existing DNS-01
  setup (EDGE.md), covers every cluster. D14's one-label rule is kept by giving clusters their own
  sub-zone, not nesting under app names.
- **DNS.** `*.k8s.<contentDomain>` is an A record to the edge, **DNS-only (grey cloud)**, created
  explicitly by the installer and Settings → Domains. Cloudflare's free certificate does not cover
  a second label, and its proxy cuts connections idle for 100 s. This publishes the edge IP, which
  mail already exposes. With multi-ingress it becomes a set of A records. EDGE.md gets a row
  saying why this one record is grey.
- **Bearer-only.** Caddy answers 401 itself to any request without `Authorization: Bearer`, except
  `GET /livez`, `/readyz` and `/version`. Unauthenticated traffic never reaches the API server,
  which removes most of its pre-auth attack surface.
- **Streams.** `watch`, `logs -f`, `exec` and `port-forward` must survive the proxy. kubectl now
  uses WebSockets for exec, attach and port-forward, which Caddy proxies, and S4 checks the rest,
  including idle timeouts.

### 6.2 Identity (K8)

The API server reads a structured `AuthenticationConfiguration` (`auth.yaml`, written by the
helper):

- One JWT authenticator: `issuer.url` = the platform origin, `audiences` = `["k8s:<clusterId>"]`.
- `claimMappings`: `username` = `yoal:` + `sub`, `groups` = the `k8s_groups` claim.
- `claimValidationRules` require `org_id` to equal the cluster's org.

`POST /api/v1/kubernetes/clusters/:name/token` returns a 15-minute ES256 token for the caller with
that audience and the groups their role grants (§6.3). It is signed under a new key-ring purpose,
`kubernetes`, so it can rotate on its own. API keys can call it, so CI works with a `yoal_` key and
no stored kubeconfig.

`yoal k8s kubeconfig <cluster>` writes a context whose `user` is an exec credential plugin:

```yaml
users:
- name: yoal-<cluster>
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1
      command: yoal
      args: [k8s, token, <cluster>, --output, exec-credential]
      interactiveMode: Never
```

The plugin caches the token until a minute before expiry. Removing someone from the org or
downgrading their role takes effect within 15 minutes, with no certificate to revoke.

### 6.2.1 Machine access (K19)

Tools that cannot run an exec plugin (Argo CD registering an external cluster, Lens, SaaS
dashboards, a Grafana datasource) use **cluster access keys**:

- `POST /kubernetes/clusters/:name/access-keys { name, role: view|edit|admin, expiresAt? }` creates
  a row in `k8s_access_keys` and a ServiceAccount `yoal-key-<id>` in `yoal-system` with a bound
  ClusterRoleBinding and a `kubernetes.io/service-account-token` Secret, all written as one
  manifest in `server/manifests/`. The kubeconfig is returned once.
- Revoking or expiring a key deletes its manifest and its ServiceAccount, which invalidates the
  token at once. Creating, rotating and revoking are audited, but use is not (the API server sees
  the ServiceAccount, not Yoal).
- Removing the creator from the org does not revoke their keys. The org's key list shows each
  key's creator so an admin can clean up.
- Native ServiceAccount tokens a user creates inside the cluster work too, and the docs show how.
  Yoal does not see them.
- Keyless CI federation (GitHub Actions OIDC trusted directly in `auth.yaml`, mapped by repo and
  branch claims) is K18.

### 6.3 RBAC mapping (K9)

New IAM resource `kubernetes` in `packages/contracts/src/iam/catalog.ts`:
`create, read, update, delete, view, edit, admin, credentials`. Scopes are `org` and `cluster`.

| Yoal permission | Token group | In-cluster binding |
|---|---|---|
| `kubernetes:admin` | `yoal:admins` | `cluster-admin` |
| `kubernetes:edit` | `yoal:editors` | `edit` (all namespaces) |
| `kubernetes:view` | `yoal:viewers` | `view` (all namespaces) |

The helper writes the three ClusterRoleBindings to `server/manifests/yoal-rbac.yaml`, which k3s
re-applies on every start, so deleting them in the cluster does not lock Yoal out. Namespace-scoped
grants (`kubernetes:edit` on one namespace) are a later extension, not a v1 need.

### 6.4 Break-glass admin certificate (K10)

k3s generates its admin client certificate. The agent reads it once after the first start, and the
control plane seals it with the org key. The agent uses it on loopback for health, upgrades and
drains. `GET /kubernetes/clusters/:name/admin-kubeconfig` needs `kubernetes:credentials` plus
step-up, is `no-store`, audited, and refused to MCP principals (D58). The returned kubeconfig
points at the public endpoint, which does not pass client certificates, so it is meant for
`private` mode over `yoal k8s proxy` or for the node itself. Rotating it is `k3s certificate rotate`
through a fixed helper verb.

---

## 7. Ingress, registry and storage (K11, K13)

- **Ingress.** Traefik stays enabled and is published on `127.0.0.1:<ingressPort>`. Each
  `k8s_routes` hostname becomes a Caddy route on the ingress nodes → the machine's node → that
  port, with the `Host` header kept. Hostnames are single-label: `yoal k8s route add <cluster>
  <name>` claims `<name>.<contentDomain>` in the same global namespace as project slugs (so the
  existing wildcard certificate and orange-cloud record cover it), or a verified custom domain on
  on-demand TLS. Caddy issues and holds certificates. In-cluster Ingress
  objects use plain HTTP `web` entrypoints. Disabling Traefik (to run ingress-nginx or Gateway
  API) is a cluster setting, and the route then targets a NodePort the user names.
- **LoadBalancer services** are unsupported in v1 (`servicelb` disabled). They stay `Pending`, and
  the docs say so. K18 maps them to Yoal TCP endpoints once `caddy-l4` or the Bun forwarder
  exists (CLUSTERING C2).
- **Registry.** The helper writes `registries.yaml` mirroring the install registry and docker.io,
  ghcr.io and quay.io to the node's loopback mirror (REGISTRY R9, R13), reached from the machine
  at `host.containers.internal:8085`. Credentials come from a cluster principal holding
  `image:pull` on the org. The agent rotates the token and rewrites the file, and containerd
  rereads it.
- **Storage (K21).** Persistent data belongs in Yoal data services (Postgres with replicas,
  Valkey, brokers, buckets) attached into the cluster (§8). Their redundancy is already planned
  (CLUSTERING §9, D107). Two StorageClasses exist for what remains:
  - `local-path` (the default, bundled): under the machine's data directory on the cluster's
    storage target. Node-local and L0, for caches and scratch.
  - `yoal-shared` (K4): an NFS CSI driver, pinned by digest, pointed at a share from the share
    registry (CLUSTERING §5.2, D143). It survives node loss and supports ReadWriteMany, with the
    share's semantics. It is for files, not databases. The create flow says so.

  Replicated block storage inside clusters (Longhorn, Mayastor) is not offered: it needs host
  access a `userns` machine does not have, and CLUSTERING §22 rejected it for the same reasons.

---

## 8. Attachments (K12)

`yoal k8s attach <cluster> <database|broker|bucket> --namespace <ns> [--secret <name>]`:

- The helper writes a Secret manifest (`<PREFIX>_URL`, `_HOST`, `_PORT`, `_USER`, `_PASSWORD`, the
  same keys an app receives) into `server/manifests/yoal-attach-<id>.yaml`. k3s applies it and
  re-applies it on start. Secret values follow D43: fetched just in time and written 0400 under
  `/run/yoal-workloads/<machineId>/`, never in desired state.
- Hosts use the `yoal-workloads` network aliases (`db-<hex>:5432`, `mq-<hex>:4222`). Pods resolve
  them through CoreDNS → the machine's resolver → aardvark-dns. This works on the same node only.
  Until cross-node endpoints exist (CLUSTERING C2), an attachment pins placement the way D56 does
  for projects.
- Rotation (database credential rotation, D134) rewrites the manifest. A Deployment that wants a
  restart on rotation uses a checksum annotation or Reloader, which the docs show.

---

## 9. Backups, upgrades, observability (K14, K15)

### 9.1 Datastore backups

| Datastore | How |
|---|---|
| SQLite (one server) | Helper verb `POST /v1/k8s/:id/snapshot` runs an online SQLite backup of `server/db/state.db`, together with `server/token` and `server/tls`, into a tarball streamed to a presigned PUT (the database backup transport, DATABASES §5). |
| etcd (three servers) | `k3s etcd-snapshot save` with S3 settings from a short-lived STS credential for the backup bucket. |

Datastore snapshots ship in K2. The schedule defaults to daily for `lab` and hourly for
`production`, keeps 7 days, and is configurable. Restoring creates a new cluster from a snapshot on
any capable node (`yoal k8s restore <backup> --name …`), because restoring in place over a live
cluster is the riskier path.

PV data (`local-path` and `yoal-shared`) is backed up by **Velero** (K5), pinned by digest,
installed through the auto-deploy manifests, writing to a Yoal bucket with a short-lived STS
credential. It is on by default for `production`. Restore brings back the datastore first, then
Velero restores volumes.

**Recovery levels (K17).** (a) Manual restore, K5. (b) Automatic restore, K7: after the node has
been offline `kubernetes.autoRestoreMinutes`, the control plane takes the cluster's lease (the
run-lease pattern, D224) and restores onto another capable node. The fenced old machines refuse to
start when their node returns, because they no longer hold the lease. (c) HA, K6 (§10). An HA
cluster that loses quorum falls back to (a) or (b).

### 9.2 Upgrades (K15)

- **Patches** apply automatically in the cluster's maintenance window (default a 2-hour slot at
  night in the platform timezone, set per cluster) once a Yoal release pins a newer patch of the
  cluster's minor. Opt-out per cluster.
- **Minors**: `PATCH { version }` moves forward one minor at a time. Downgrades and skips are
  refused. The agent reads `apiserver_requested_deprecated_apis` and the cluster page lists APIs
  still in use that the next minor removes. Warnings go out 60 and 30 days before the minor leaves
  the support window. At end of support the cluster is upgraded one minor automatically in its
  window. Releases drop versions that leave the window, so the pinned set stays bounded.
- Both run as a `kubernetes.upgrade` flow (FLOWS.md), so a control-plane restart resumes it. For
  each server, then each agent: cordon and drain with the admin certificate (timeout, then pause for
  a person), swap the image through `apply`, wait for `Ready` and the version, then uncordon. If
  the API does not come ready, the flow puts back the previous image and pauses. A single-node
  cluster has a short API outage. Pods restart with the machine. The create flow states this.
- Node updates (D217) restart the agent and helper, not machines, so a fleet rollout never touches
  a cluster.
- Certificates: k3s renews certificates within 90 days of expiry when it restarts. The agent
  schedules a restart in the cluster's maintenance window when expiry is under 30 days, and alerts
  at 14 days.

### 9.3 Metrics, logs, alerts

- The agent samples machine cgroups like other containers. Through metrics-server it adds node and
  pod counts and requested versus allocatable memory, as `yoal_k8s_*` series
  (`packages/core/src/telemetry.ts`).
- Machine stdout goes to `k8s_log_events`.
- **Shipper (K23, K5).** One toggle installs a pinned Vector (or OTel Collector) DaemonSet and
  `kube-state-metrics` through the auto-deploy manifests. It tails container logs, scrapes kubelet
  and cAdvisor, and pushes to a per-cluster ingest endpoint with a cluster-scoped token. Logs appear
  on the cluster page, filterable by namespace, pod and container. Metrics feed Yoal's charts and
  alerts. Retention follows the org's telemetry settings and counts toward its usage. It is off by
  default for `lab`, on for `production`, and hidden when the optional ClickHouse store is not
  installed. Without it, pod logs stay in the cluster (`kubectl logs`).
- Alerts: API not ready, a node `NotReady`, memory requests above 90% of allocatable, certificate
  expiry, backup failure.

---

## 10. Multi-node clusters and HA (K5, K17)

Built (D232). A cluster's machines can sit on several capable nodes.

- **Routed machine subnets.** Each node with the component owns a /24 of `10.48.0.0/16`
  (`10.48.<n>.0/24`, n from its overlay address). Its WireGuard peers carry that /24 next to the
  node's /32 (only to nodes whose agent advertises `wg-subnets`), every node routes the /16 into
  `wg0`, and the helper's firewall allows forwarding from `wg0` to it (ufw `route allow`, an nft
  forward chain). Multi-node machines join the node's `yoal-k8s` Podman network (MTU 1370) with a
  fixed address, plus their org network for attachments. k3s gets that address as `--node-ip`, so
  flannel VXLAN, the supervisor and etcd use their default ports, with no per-cluster port maps.
  This replaced the per-cluster port plan, which could not move etcd's fixed ports.
- **S3 (passed with two fixes, `spikes/k8s/s3/RESULTS-S3.md`).** netavark masquerades traffic
  leaving the bridge, so etcd saw a peer's `wg0` address and refused the join: every node now
  carries an `inet yoal-k8s` table whose postrouting rule (priority `srcnat - 10`) source-NATs
  machine-to-machine traffic to itself, whatever the firewall backend. A machine on two networks
  had two equal default routes and flannel followed whichever came first: the `yoal-k8s` network
  now has `metric=50` and a route for the supernet, the machine's interface there is `k8s0`, and
  k3s runs with `--flannel-iface=k8s0`. With both, three nodes were Ready, pod and Service traffic
  crossed nodes (20 MiB at full speed, pod MTU 1320), `exec`/`logs` went through the tunnel, and a
  three-server cluster kept its API with one server down.
- **Placement.** `servers: 3` or `nodes: [...]` makes a multi-node cluster. Servers land on distinct
  nodes, different zones first, then most free memory. Agents spread round-robin. Every node must
  offer the same tier. Memory is admitted on each machine's node.
- **L2**: three servers on embedded etcd. The first starts with `--cluster-init`; the others join
  it at its routed address. The edge's API route lists every server node as an upstream (Caddy
  picks the first healthy one, retries for 5 s, and sets a failed node aside for 30 s).
- **Make highly available** (production clusters only): a pre-upgrade snapshot, then the server
  restarts on etcd (`--cluster-init` converts SQLite in place) on its routed address, agents move
  to the routed network, and maintenance adds the two missing servers one at a time, each once the
  others run. S8 (conversion under load on a real node) is still to run.
- **Cross-node attachments** are still unbuilt (CLUSTERING C2): an attachment needs the cluster's
  first server on the service's node.

## 11. Surfaces

Everything goes through `packages/core` (`KubernetesService`). REST, MCP, CLI and the dashboard are
thin.

| Surface | What |
|---|---|
| REST | `/api/v1/kubernetes` (list, create), `/:name` (get, patch, delete), `/:name/token`, `/:name/admin-kubeconfig`, `/:name/routes`, `/:name/attachments`, `/:name/backups`, `/:name/machines`, `/:name/upgrade`, `/:name/logs`. |
| CLI | `yoal k8s create\|list\|get\|delete\|kubeconfig\|token\|proxy\|upgrade\|route\|attach\|backup\|restore`. |
| MCP | Lifecycle tools (`list_k8s_clusters`, `create_k8s_cluster`, `get_k8s_cluster`, `upgrade_k8s_cluster`, `add_k8s_route`, `attach_to_k8s_cluster`, `delete_k8s_cluster`, the last gated like other deletes). In-cluster tools (K20): `k8s_get`, `k8s_logs` (K3), then `k8s_apply` (server-side apply), `k8s_delete` (confirmation gate) and `k8s_rollout_restart` (K4). Yoal calls the API server with a token minted for the calling principal, so its RBAC applies, and every call is audited. Secret `data` is redacted. **No tokens and no kubeconfig through MCP** (D58). |
| Dashboard | **Kubernetes** in the sidebar, shown when any node has the capability or any cluster exists. A create wizard (name, version, node or auto, size, tier, API access) states the tier's exposure and that PVs are node-local. Cluster page tabs: Overview (endpoint, version, machines, health, the `yoal k8s kubeconfig` snippet), Access (roles, allowlist, break-glass), Routes, Attachments, Backups, Upgrades, Logs, Settings, Danger zone. |
| Nodes | Components card with Install/Remove (§3.2), tiers detected, machines placed. |

---

## 12. Spikes (phase K0)

| # | Question | Pass condition |
|---|---|---|
| S1 | Does k3s run as a privileged container inside `UserNS=auto` under rootful Podman on Debian 13 with cgroup v2, including CoreDNS, Traefik, local-path, a privileged pod and `hostPath`? | Conformance smoke test (sonobuoy quick mode) passes, and from a privileged pod `hostPath: /` shows only the machine's view, never host-writable files. |
| S2 | Footprint and memory accounting | Idle RSS of a combined machine measured. Allocatable equals `MemoryMax` minus reserved. A pod that overruns is evicted by the kubelet before the cgroup OOM-kills k3s. |
| S3 | Multi-node over `wg0` | Two machines on two nodes with per-cluster ports. Pod-to-pod and service traffic works. `wireguard-native` and `vxlan` compared for throughput and MTU errors. |
| S4 | API through edge Caddy → worker Caddy → loopback | `exec`, `attach`, `port-forward`, `logs -f` and a 30-minute `watch` survive. A Caddy config reload keeps established streams. |
| S5 | Structured authentication with Yoal's ES256 issuer | The API server fetches JWKS from inside the machine. Audience and `org_id` rules reject a token for another cluster or org. A key-ring rotation causes no outage. |
| S6 | Firewall coexistence | k3s iptables/nft rules stay inside the machine's network namespace. The host `inet yoal` table and netavark rules are unchanged after a cluster starts and stops. |
| S7 | SQLite snapshot and restore | A snapshot taken under load restores on another node into a working cluster with the same objects and a working token flow. |
| S8 | SQLite → embedded etcd conversion (`--cluster-init`) | Converting a loaded cluster keeps every object. Two more servers join. Rolling back from the forced snapshot works. Run ten times without a failure. |

---

## 13. Open questions

Settled in the grilling session (§16). Still open:

1. **Which node is dedicated first.** A deploy-time choice. The homelab is the likely first
   `kubernetes=dedicated` node (room for 2 GB+ machines, and the only node that could get
   `/dev/kvm`). HA (K6) needs three capable nodes, ideally in two zones.
2. **Projects onto a cluster.** Deploying Yoal projects into a managed cluster (a Kubernetes
   `RuntimeDriver`) is out of scope. The managed cluster model does not block it later.

---

## 14. Phases

| Phase | Delivers | Done when |
|---|---|---|
| **K0** | Spikes S1, S2, S4, S5, S6, S7 | Each has a written result here. The default tier is decided. |
| **K1** | Node component: script, installer flag, `/v1/components` verb, dashboard Components card, converge step, capabilities and tiers in the heartbeat, `kubernetes=dedicated:<org>` label and placement rules, per-org `trusted` grant | A node installs and removes the component from the dashboard, and the capability appears and disappears. |
| **K2** | Single-node clusters (`purpose: lab` only): tables, `KubernetesService`, `k8s` helper profile, admission and quotas, health, admin cert sealing, **datastore snapshots**, REST, CLI, dashboard list/create/delete, break-glass kubeconfig | `yoal k8s create demo` gives a cluster where `kubectl get nodes` (through `yoal k8s proxy`) shows one Ready node. A snapshot exists within a day. Delete purges it. |
| **K2.5** | Several agent machines on one node (machine count in the create flow, add/remove agents) | A three-agent cluster on one node drains an agent and reschedules its pods. |
| **K3** | Identity and access: `kubernetes` key-ring purpose, token endpoint, exec plugin, RBAC manifests, access keys (K19), public route with the `*.k8s` wildcard, DNS-only record and Bearer-only rule, allowlist, private mode, MCP read tools | A user with `kubernetes:view` can list pods but cannot create them. Removing their role locks them out within 15 minutes. A revoked access key fails at once. |
| **K4** | Routes, registry pulls, attachments, `yoal-shared` StorageClass, MCP apply/delete/restart | An Ingress serves `myapp.<contentDomain>` over HTTPS. A pod pulls a private image from the Yoal registry, reads an attached database URL, and writes to a `yoal-shared` PV. An agent deploys a manifest from chat. |
| **K5** | Restore, Velero, maintenance windows and automatic patches, minor upgrades with deprecated-API warnings, certificate renewal, log/metric shipper, metrics and alerts. **`purpose: production` unlocks here** | A restore drill on the real production candidate passes (datastore and PVs, on another node), and a patch upgrade runs unattended in the window. |
| **K6** | Cross-node attachments (CLUSTERING C2) first, then S3 and S8, multi-node clusters, UDP in the `wg0` allowlist, three-server HA, "Make highly available" | A three-server cluster across two zones keeps its API and its attached database when one node is powered off. A converted cluster keeps every object. |
| **K7** | Automatic restore behind a lease, then the other K18 items, each its own plan | |

Docs to amend when K2 ships: DESIGN §1 non-goals ("Kubernetes **as Yoal's scheduler**"), build-plan
README rule 8 (same qualifier), CLUSTERING §22.1 (a note that hosted clusters are a tenant product
and the verdict is unchanged), D56 (the API route is an HTTP route to the cluster's own loopback
listener, not a public bind), and ROADMAP.

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| A cluster admin escapes to the host | Tier model (§5.2): `userns` only if S1 proves it, `trusted` restricted to the platform owner and dedicated nodes, `vm` later. |
| k3s footprint crowds out other workloads | Machines are admitted against the slice budget (D42). Ingress and control nodes are excluded by default. Minimum 1 GB per machine. |
| Kubelet schedules against host memory | Allocatable derived from `MemoryMax` (K16, S2). |
| Proxy breaks streaming APIs | S4 before K3. `private` mode with `yoal k8s proxy` as a fallback. |
| Node-local PVs are lost with the node | Stated in the create flow and docs. Velero (K18) and application-level replication. |
| Version churn (Kubernetes releases about three minors a year) | Three supported minors, pinned in releases. Alerts when a cluster's version leaves the window. One-step upgrade flow. |
| Supporting Kubernetes itself, not just Yoal | Yoal's promise is the lifecycle (create, access, upgrade, back up, delete) and the integration points. What runs inside is the tenant's, and the docs say so. |

---

## 16. Grilling record (2026-11-18)

| # | Question | Answer |
|---|---|---|
| G1 | Who is this for? | The platform owner and trusted people in other orgs. Isolation is against mistakes, not attackers. |
| G2 | Can another org run `trusted`? | Yes, if the platform owner grants it, and only on dedicated nodes (K4). |
| G3 | Can one dedicated node hold several orgs' `trusted` clusters? | No. Nodes are bound to one org by an explicit owner label (K24). |
| G4 | Single-node only in v1? | Yes, plus several agent machines on one node (K2.5). |
| G5 | Production use? | At least one production cluster. Snapshots move into K2, Velero is planned. |
| G6 | Node-loss recovery | Support all three: manual restore, automatic restore, HA. Ship in that order (K17). |
| G7 | Where does persistent data live? | Yoal data services attached into the cluster, plus `yoal-shared` NFS PVs. Cross-node attachments gate K6 (K21). |
| G8 | API public by default? | Yes, with Caddy refusing requests without a Bearer token. |
| G9 | Machine credentials | Yoal access keys (K19), native ServiceAccount tokens documented, keyless federation later. |
| G10 | Hostnames | `*.k8s.<contentDomain>` for APIs, single-label claimed names for ingress (K7, K11). |
| G11 | Grey-cloud `*.k8s` on the edge IP? | Yes. |
| G12 | MCP | Read tools in K3, apply/delete in K4, all on the caller's RBAC (K20). |
| G13 | Upgrades | Automatic patches in a maintenance window (opt-out), minors manual until end of support, then automatic (K15). |
| G14 | HA level fixed at creation? | No. SQLite converts to etcd in place for `production` clusters, if S8 passes (K17). |
| G15 | Pod logs and metrics | An opt-in shipper into ClickHouse, on by default for `production` (K23). |
| G16 | When can a cluster be `production`? | Once K5 ships (K22). |
| G17 | Clusters on ingress/control nodes? | Only when named explicitly (K25). |

---

## 17. What is built (2026-11-18)

**K0–K6 are built.** The spikes S1, S2, S5-lite, S6 and S7 passed in an OrbStack Debian 13 VM
(arm64, `spikes/k8s/RESULTS.md`). Their findings are in the helper: the cgroup v2 entrypoint, the
`/proc/meminfo` sized to the limit, explicit mounts for the image's volumes, `--oom-score-adj=-999`,
`Restart=always`, a reserve of at least 768 MiB, a 2 GiB minimum machine, all three eviction
signals, and Traefik on a hostPort.

- **K1 node component**: `apps/helper/src/kubernetes-component.ts` (prerequisites, modules,
  sysctls, image pulls, digest-checked airgap bundles, tier probe with the entrypoint, marker),
  `--with-kubernetes`, `scripts/install/kubernetes.ts`, convergence, the helper's background
  `/v1/components/kubernetes` verb, and Settings → Kubernetes.
- **K2/K2.5 clusters**: migration 0116, `KubernetesService`, the helper `kubernetes` profile,
  admission, quotas, health, purges, agents 0–8.
- **K3 access**: tokens and the exec plugin, RBAC manifests, access keys, the bearer-only public
  route under `*.k8s.<contentDomain>`, allowlists, private mode, MCP read tools.
- **K4**: routes, attachments, the manifest channel (helper `/v1/kubernetes/<id>/manifests`).
- **K5** (D230, D231): datastore snapshots (SQLite online copy or etcd snapshot, plus token, TLS,
  credentials and `storage/`, the local-path volumes) to the backup target on a schedule (24 h lab,
  1 h production; 7-day retention, the newest good one always kept). Restore into a new cluster,
  which waits for its snapshot and keeps the source's join token. The status sample prunes nodes of
  removed machines and of the restored cluster. Rollouts move one machine at a time (servers first)
  with a snapshot before any minor change, and roll back if a machine is not running again within
  15 minutes (automatic patching then pauses). Patches apply in the window; end of support moves a
  minor in the window. Alerts cover a cluster unhealthy for 10 minutes, failing snapshots,
  rollbacks, and end of support at 60 and 30 days, listing deprecated APIs still in use. The log
  shipper (pinned Vector DaemonSet → `/api/v1/kubernetes-ingest/<cluster>`, a per-cluster token)
  stores pod logs with per-cluster retention. `purpose: production` is allowed and defaults hourly
  snapshots and the shipper.
- **K6** (D232): routed machine subnets, multi-node placement, three-server etcd HA, HA conversion,
  HA API upstreams.
- **Surfaces**: REST, `yoal k8s`, MCP and dashboard for everything above.

**Not built yet:**

- Velero for PVs beyond local-path data in snapshots (snapshots copy `storage/`; other CSI drivers
  are not covered), the `yoal-shared` NFS StorageClass, registry pull credentials (K13), drains
  before a machine moves (machines restart in place), cross-node attachments (CLUSTERING C2), and
  per-cluster isolation between machines on the routed network (auth is the boundary today).
- K7/K18: automatic restore behind a lease, the `vm` tier, keyless CI federation, workload
  identity, LoadBalancer services, `yoal k8s proxy`, the break-glass admin certificate, MCP
  `k8s_apply`.
- S3 passed in two OrbStack VMs (arm64) with the fixes above. Spikes still to run on a real Debian amd64 node: S4 (streams
  through two Caddy hops), the full S5 (tokens end to end), and S8 (SQLite → etcd under load).
  Nothing has run on the prod fleet.

---

## 18. Configs from natural language (D233)

"Write a Kubernetes config in plain words" for a cluster: *"nginx serving a static site on shop,
two replicas"* becomes a Deployment, Service and Ingress that fit this cluster, checked before
anyone applies them. The model only proposes objects. Everything around it is deterministic:

1. **Context** (`KubernetesService.manifestContext`): the cluster's version, ingress class (Traefik
   or none), claimed route hosts, attachment Secrets with their exact keys (`URL`, `HOST`, …),
   storage classes (`local-path`), memory pods can use (machine limit minus the kubelet reserve,
   times schedulable machines) and the platform registry host.
2. **Generate** (`apps/control-plane/src/lib/server/kubernetes-ai-pipeline.ts`): one tool,
   `emit_manifests`, returns `{summary, manifests[], assumptions[], questions[]}` with manifests as
   JSON objects, so nothing ambiguous is parsed. The system prompt carries the facts and the house
   rules: no LoadBalancer, Ingress on claimed hosts, no TLS sections (Yoal terminates HTTPS),
   attachment Secrets by name and key, never invented credentials, resources on every container,
   pinned tags, probes, ReadWriteOnce volumes. A model that answers with a fenced YAML block instead
   is still accepted.
3. **Lint and fix** (`packages/core/src/kubernetes-manifests.ts`, pure): fixes what Yoal owns
   (current API versions, the ingress class, dropped TLS and cert-manager annotations, LoadBalancer
   → ClusterIP, default requests and memory limits, selectors from pod labels, storage class,
   namespaces, a `yoal.io/generated-by` annotation). It reports what it cannot decide: unclaimed
   hosts (with the `yoal k8s route add` command), unknown Secrets or keys, literal secret values,
   hostPath, privileged containers, `:latest`, RWX volumes, Services that select nothing, memory
   over the cluster's capacity, duplicates.
4. **Repair**: lint errors go back to the model as the tool result, at most twice (three rounds).
5. **Emit**: Yoal's own YAML emitter (block style, `|` for multi-line strings, quoting only where
   needed). Optionally a **server-side dry run** on the cluster.

**Apply** (`KubernetesService.applyManifests`, `packages/core/src/kubernetes-api.ts`): server-side
apply (`PATCH … application/apply-patch+yaml`, `fieldManager=yoal`, `fieldValidation=Strict`) in
dependency order, after discovery maps each kind to its resource. It runs with the **caller's own
15-minute token** against the cluster's public API, so the cluster's RBAC decides (K8, K9). Yoal
also requires `kubernetes:edit` for a real apply (`kubernetes:view` for a dry run), lints the YAML
first, refuses private or not-running clusters, and audits `kubernetes.apply`. Generation is
audited as `kubernetes.generate` (prompt length, model, object count, rounds, never the prompt).

**Model and limits**: it uses the dashboard assistant's provider (Settings → Assistant, any
OpenAI-compatible endpoint with tool calling) and its per-user turn limit. Without a provider the
endpoint answers 503 and the surfaces point an owner at Settings → Assistant.

**Surfaces**:

- `POST /api/v1/kubernetes/:name/generate` streams, because generation outlives the server's idle
  timeout: SSE `progress` frames, then `result` (or `error`). Without `Accept: text/event-stream`
  it sends JSON preceded by keep-alive whitespace.
- `POST /api/v1/kubernetes/:name/apply` applies or dry-runs YAML.
- The dashboard's **Write config** tab: prompt, live progress, editable YAML, findings, refine,
  dry run, apply.
- `yoal k8s write <cluster> "<prompt>" [--from file] [-o out.yaml] [--dry-run] [--apply]` and
  `yoal k8s apply <cluster> -f file`.
- MCP `generate_k8s_config` and `apply_k8s_config` (a real apply needs confirmation). These also
  reach the dashboard assistant's chat.
