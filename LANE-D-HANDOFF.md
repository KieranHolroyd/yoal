# Lane D hand-off — W8 driver contract + `external-lb`

Branch `ha/w2-d-external-lb`, base `ha/integration` at `416996dd`. Implementation commit
**`80c681d3`**. No merge to `main`, no cloud spend, no `VERSION` bump.

## What shipped

- **Driver registry/factory** — `packages/core/src/steering/`:
  - `registry.ts`: `STEERING_DRIVER_FACTORIES`, `createSteeringDriver()`,
    `implementedSteeringDrivers()`. Absent kinds throw `not implemented … steering driver <kind>`
    instead of steering nothing.
  - `direct/index.ts`: today's behaviour, moved out of `ingress-service.ts`; capability
    `none/false/native`.
  - `external-lb/index.ts`: the reference read-only driver.
  - `types.ts` / `snapshot.ts`: the read-only context a driver receives (node snapshot, ingress
    settings, clock) and the shared health classification.
- **Conformance suite** — `steering/conformance.ts`; `steering/conformance.test.ts` runs it for
  `direct` and `external-lb`. It asserts the contract, deterministic preflight, the conventional
  `observe()` shape (`kind`, `observedAt`, `healthy`, `serving`), idempotent `desired()`, a frozen
  read-only context, and never-remove-the-last-healthy-ingress. A new driver is one registry line
  plus a call to `describeSteeringConformance`.
- **`external-lb`**:
  - `probes: 'external'`, `writes: false`, `preservesClientIp` derived from config:
    `proxyProtocol` → `proxy-protocol`, else non-empty `trustedProxies` → `header`, else `native`.
  - `preflight()`: refuses an empty fleet (fleet-wide), a node whose agent lacks `ingress-set`, a
    node that never heartbeated, and `proxyProtocol` with an empty `trustedProxies` (the Access-rule
    address would be the balancer's).
  - `desired()`: pure/idempotent, no provider call, computes the intended serving set and keeps the
    previous set when every node is unhealthy (never empties it).
  - `observe()`: the health path (`/.well-known/yoal/health`), port (`ingress.healthPort`, else
    8099), HTTP/HTTPS flags, client-IP mode, per-node health/draining/capability and the serving
    set. It reads the edge's own heartbeat/status; `external-lb` has no provider read API.
- **Wiring**:
  - `cluster_config.steering = { driver, stacked[] }`, default `direct`; `STEERING` flag stays in
    `OPT_IN_FEATURES` and off. With the flag off the saved choice is inert and `direct` is used.
  - `steering.driver` in the failover controller tick: read-only drivers run every tick; a
    write-capable driver's `desired()` runs only while `fence.holds()` is true. Findings/errors
    surface as `steering:preflight` / `steering:error` alerts and in `FailoverTickReport.steering`.
  - The legacy manual DNS rotation (`policies.ingressDriver`) still runs with the flag off, and is
    skipped only when an implemented steering driver is active.
  - `FailoverStatusView.ingress.driver/steers/rotates` and `IngressSetView.steering` reflect the
    selection.
- **Docs** — `docs/rig/haproxy/README.md` + `haproxy.cfg`: probe path/port, `inter 5s fall 2
  timeout 2s` (≈14 s worst-case removal), L7 recommended / L4 passthrough, PROXY v2 +
  `trustedProxies`, no `on-marked-down shutdown-sessions`, drain sizing (`drainSeconds` > detection),
  other balancer families, and the S9 measurement references.

No migration. `0127` is unused; all state is the existing `settings` JSON row.

## Verified

- `bun run check` — all packages pass (one pre-existing Svelte warning in
  `settings/registry/+page.svelte`).
- `bun test` — **6295 pass, 74 skip, 0 fail** (6369 tests, 572 files), including
  `packages/core/src/desired-state/golden.test.ts`, whose `singleNode()` fixture is the
  code-level single-node gate (one node, every flag at its default; desired state unchanged).
- Conformance: `direct` + `external-lb` (21 suite assertions plus driver-specific tests).
- Preflight refusals: empty fleet, missing `ingress-set`, never-heartbeated node, PROXY header with
  no trusted proxy; all return a reason and the right `nodeId`.
- Driver selection: default `direct`; saved `external-lb` inert with `STEERING` off; selected and
  acting with the flag on; unimplemented `vip`/`dns-failover` reported as a reason, not a crash.
- Never-remove-last-healthy: conformance mutates 3 healthy → 1 healthy → 0 healthy and asserts the
  intended serving set shrinks to the healthy node and is never emptied.
- Flag-off path: `dns-failover` manual rotation still withdraws a silent ingress and records a
  `manual` event; `report.steering` is `direct`/inactive.
- Lease rule: a fake write-capable driver is not called with `fence = null` or `holds() === false`,
  and is called once when `holds() === true`; `observe()` still works while waiting.
- Cluster config: steering persists/merges without resetting neighbours; `direct` stacking,
  duplicates and stacking the primary driver are refused; unknown driver names are rejected.

## Not verified

- **Live lab timing.** HAProxy kill ≤ 15 s, drain with zero failed requests and the Access-rule
  client-address check are the lab lane's scenarios; no lab/docker scenario was run in this
  worktree (the shared `yoal-w0-*` lab belongs to the lab lane).
- **Cloud balancers.** Azure LB, AWS NLB, GCP LB, Hetzner LB and F5 are configuration recipes only;
  S9's cloud half is the lab/cloud lane's.
- **Real health endpoint / lame duck / PROXY rendering.** Lane C owns `compile.ts` and the agent
  listeners. `external-lb` describes the path/port and capability gates it; it does not serve them.
  The 8099 default mirrors the S9 rig and is a placeholder until lane C reserves the production port.
- **Stacked-driver execution.** `steering.stacked` is stored, validated and shown; only the primary
  driver is reconciled. Stacking is W13 (regions) in the plan.
- **Operator surface.** There is no new REST/CLI preflight route; `core.steering.preflight()`,
  `core.failover.status()` and `IngressSetView.steering` are the service surfaces. The existing
  `PATCH /api/v1/cluster/config` accepts the new section.
- **Mixed-version agents.** No new capability string was added: `external-lb` reuses `ingress-set`.

## Deviations / notes for the integrator

1. **Cluster config gained `ingress` merging.** `ClusterConfigService.update()` already validated
   and defaulted `ingress` but did not merge it, so `ingress.*` changes were dropped. Lane D needs
   `proxyProtocol`/`trustedProxies`/`drainSeconds` to be real for the external-lb capability and
   preflight, so the merge line was added. This is the only pre-existing behaviour touched outside
   the steering module; if lane C is editing the same function, take one line and keep both.
2. **Driver choice lives in `cluster_config.steering`, not `platform_policies.ingressDriver`.**
   The policy key remains the legacy DNS/failover setting (its enum has the old four values) and is
   untouched, so an upgrade keeps today's status. The new setting is the H18 selection.
3. **`SteeringService.active()` means "an implemented driver is acting".** An operator who selects
   `dns-failover` or `vip` with `STEERING` on gets a preflight reason; the legacy manual rotation
   keeps running rather than being disabled by a driver this build cannot run.
4. **Health port 8099** appears in the driver's `observe()` and the recipe (S9's rig port). Lane C
   should align or override via `ingress.healthPort`; it is display/metadata only.
5. **`desired()` signature** stays the foundation's `desired(): Promise<void>`; the plan sketch
   showed `desired(set: IngressSet)`. Drivers receive the set through the read-only context instead,
   which keeps the contract unchanged.

## Final SHA

- Implementation: `80c681d3` (branch `ha/w2-d-external-lb`).
- This hand-off is committed on top; the tip is reported in the hand-back message.
