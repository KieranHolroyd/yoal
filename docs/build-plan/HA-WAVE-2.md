# HA Wave 2 — no single edge (M2)

Plan: [HA-PLAN.md](../HA-PLAN.md) §5 wave 2, §6.5. Base: `ha/integration` after Wave 1 (every lane
below starts from it). No HA branch merges to `main`; the owner merges.

**M2:** kill any ingress behind HAProxy or Azure LB: out in ≤ 15 s; drain: zero failures.

## Opening (one agent, merges alone before lanes)

1. The `ingressNodes()` refactor with the set still of size one (no behaviour change, suite green,
   golden unchanged).
2. Foundation PR 2: ingress role and set in the schema/contracts, steering driver contract and
   conformance suite, certificate lease/custody contracts, flags, empty services. One author.

## Worktrees and assignments

| Plan | Worktree | Branch | Migration reservation |
|---|---|---|---|
| Opening: `ingressNodes()` refactor | agent worktree | `ha/w2-ingress-refactor` | none — **merged** (`7c7deb57`), golden byte-identical |
| Opening: foundation PR 2 | `ha/integration` (single author) | `ha/w2-foundation` | **`0122_ingress_certificates.sql` used**; `0123` remains spare |
| A — W6 payload: full route tables, releases and placeholders on every ingress; worker public listeners/TLS; shared secrets through activation; redeemed-token cache; drift from `actualStateVersion` | agent worktree | `ha/w2-a-ingress-payload` | `0124` spare |
| B — W7 certificates: ACME lease, custody sealed with the master key, distribution through activation, fingerprint in heartbeat, HTTP-01 relay, BYO certificates, reissue on removal | agent worktree | `ha/w2-b-certificates` | `0125` spare |
| C — W8 health, lame duck, PROXY, trusted proxies | agent worktree | `ha/w2-c-edge-health` | `0126` spare |
| D — W8 driver contract consumers: `external-lb` recipe + conformance run | agent worktree | `ha/w2-d-external-lb` | `0127` spare |
| E — DNS providers: `dns-failover` with `cloudflare`, then the other providers (one agent per provider after the contract) | agent worktree | `ha/w2-e-dns` | `0128` spare |

Renumber at merge time, as Wave 1 learned: a lane's "spare" is only a claim, not a number. The
integrator keeps the stream contiguous.

## Flags

| Workstream | Flag | Capability |
|---|---|---|
| W6 ingress set | `INGRESS_SET` (new, opt-in) | `ingress-set` |
| W7 certificates | `SHARED_CERTIFICATES` (new, opt-in) | `ingress-set` (the same nodes) |
| W8 steering | `STEERING` (new, opt-in) | — (control-plane driver) |
| W8 edge health | none: additive (`healthPath` already shipped) | — |

Every flag is in `OPT_IN_FEATURES` (default off). `SERVICE_ENDPOINTS` is not reused.

## Merge order

1. `ha/w2-ingress-refactor` alone (no behaviour change; golden unchanged).
2. `ha/w2-foundation`.
3. C (edge health) before D (`external-lb` needs the public health endpoint and lame duck).
4. B anytime (certificates depend on the ingress set only).
5. A after C/D when both are ready, so the payload lands on the final edge contract.
6. E after the driver contract; providers can merge one at a time.
7. Lab scenarios last.

## Known integration conflicts

- `packages/core/src/nodes.ts`: every lane (the set, certificates, routes).
- `packages/site-config/src/compile.ts`: A (payload) and C (PROXY, lame duck).
- `packages/contracts/src/agent.ts`: B (fingerprint) and A (listeners).
- `apps/agent/src/main.ts`: A (listeners) and C (health/PROXY).
- `packages/core/src/steering/*`: D and E share the conformance suite but own separate drivers.

## Verification

Each lane: `bun run check`, `bun test`, the single-node gate, a review from an agent that has not
seen the author's reasoning, and its exit scenario in the lab. After integration: two-ingress
same-response for every route type, HAProxy kill/drain with zero failures, and the access-log
address checks.

## Deferred out of Wave 2

- `cloud-lb`, `cloudflare-lb`, `cloudflare-tunnel` (after M5).
- Region modelling (W13).
- The Wave 1 residual gaps in [HA-WAVE-1-REPORT.md](./HA-WAVE-1-REPORT.md), except the Azure
  presign contract, which lane D needs for `external-lb` uploads.
