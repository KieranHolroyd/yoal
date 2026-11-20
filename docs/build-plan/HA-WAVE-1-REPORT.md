# HA Wave 1 report — stateful apps scale out (M1)

Plan: [HA-PLAN.md](../HA-PLAN.md) §5 wave 1, §6.5. Base: `main` at `83d4e469` plus Wave 0, then
Wave 1 merged into `ha/integration`. Nothing has merged to `main`; the owner merges.

## Branches

| Lane | Branch | Tip merged | State |
|---|---|---|---|
| Opening: desired-state split | `ha/w1-split` | `fbf5ccf8` | merged, suite green, golden pinned |
| Fixes F7–F12 | `ha/w1-fixes` | `7f353c02` | merged |
| Opening: foundation PR 1 | `ha/w1-foundation` | `418de034` | merged (flags, migrations 0118–0120, stubs) |
| A — W4 agent and helper | `ha/w1-a-attach-agent` | `5dfc3417` | merged |
| B — W4 core and placement | `ha/w1-b-attach-core` | `05ed9113` | merged; migration renumbered to `0121` |
| C — W5 rollout and release command | `ha/w1-c-release` | `09e2c246` | merged |
| D — W5 runtime, drain, readiness | `ha/w1-d-drain` | `6fe87981` | merged |
| E — W3 object-store backends | `ha/w1-e-object-stores` | `128ddc4a` | merged behind flags |
| Lab and M1 scenarios | `ha/w1-lab` | `92e80fb4` | merged last |

Integrated tree: `ha/integration` `d39699bb` plus the review-fix commit `b428efc9` and the
live-app regression test. `main` untouched; `VERSION` unchanged.

## Gate

- `bun run check`: 0 errors (one pre-existing control-plane Svelte warning).
- `bun test`: **6257 pass, 74 skip, 0 fail**.
- Single-node gate: with every new flag off, one node, the golden desired state is unchanged
  (`desired-state.golden.json` is pinned and green). `attach-gateway.test.ts` asserts the
  flag-off container path; `release-phase-writes.test.ts` asserts every release-phase write is
  refused with the flag off.

## What each lane shipped

- **A**: gateway-address forwarder binds (private gateway only), `AddHost` fixed verb, node CA
  trust install, closed helper validation table, install-CA provider TLS.
- **B**: `service_endpoint_roles` (0121) with `primary`/`pool`/`read`; containers may place copies
  off the database node behind `ENDPOINTS_GATEWAY`; stable per-node endpoints so a promotion
  changes no env and restarts nothing; pooled/read endpoints; core-side node CA issuance.
- **C**: `ReleaseCommandScheduler` (I16 lease, start deadline, timeout terminal, no auto-retry),
  rollout gating on the gate, canary judge from per-copy edge counters, image pre-pulls, HA level
  from placement (topology), per-app spread consumption.
- **D**: agent release-command runner (start-by refusal, self-kill at timeout, persisted
  seen/pending record before start, fail-closed corrupt state), drain ordering, readiness path in
  Caddy, `TimeoutStopSec`.
- **E**: one `ObjectStore` interface with S3 (region/path-style, multipart, strong-ETag guard),
  Azure Blob and GCS, a conformance suite, timeouts/stall guards, and the platform/backup wiring.
- **Lab**: four-node nested-container lab, s3lab, fault verbs, and the M1 scenario library:
  `attachments-three-nodes`, `rolling-deploy-under-load`, `kill-node`, `freeze-agent`,
  `single-node-gate`; CI runs the gate and kill-node.

## Reviews and dispositions

Every lane was reviewed by an agent that did not write it (diff + exit criteria only).

| Lane | Verdict | Disposition |
|---|---|---|
| A | SHIP WITH FIXES | Fixed: `databaseHostAlias` now matches the name apps dial; the agent refuses to bind a non-private gateway address (new `isGatewayAddress` + test). Open, documented: one gateway address cannot serve multiple org bridges (needs a contract change); guard table not cleared when the flag goes off. |
| B | integrator read-through | The independent reviewer could not run (Claude quota). Integrator checked migration 0121 (additive, backfill, index), the container gate behind `ENDPOINTS_GATEWAY` + capability, `version` bumping only on an upstream change, and the flag-off golden. This is **not** the required independent review; re-run it when quota allows. |
| C | DO NOT SHIP | Fixed the three blockers: gate on the run (`none` no longer withholds), hold the running release when the previous pointer was pruned, set a rollout for a gated first deploy. Also fixed a queued deploy being failed behind a long migration, and made the per-app lease exclusion part of the lease UPDATE. Added a live-app regression test. |
| D | SHIP WITH FIXES | Fixed: retry deadline spin after a drain; `null` desired state no longer stops in-flight runs; persist the pending record before the helper starts (I16); corrupt state fails closed. Open: drain deadline vs Caddy apply ordering; readiness does not gate the edge until the agent reports ready (lane C owns the ordering). |
| E | DO NOT SHIP as the W3 exit | Fixed: cancel the wrapped upload stream on failure; cancel the Azure multipart source; GCS reports `objectLock: false` for a readable bucket without a retention policy. Open blocker: Azure `presignPut` cannot carry `x-ms-blob-type`, so real Azure presigned uploads/backup targets fail; needs `{url, headers}` in the contract. Also open: GCS presign path encoding, real-service immutability, no CI job for the e2e suites. |
| Lab | integrator read-through | The independent reviewer could not run (Claude quota). Integrator checked that `rolling-deploy-under-load` judges zero non-2xx at ≥95% of 10,000/min and the failing-command path, and that `attachments-three-nodes` asserts spread, promotion env/restart per copy, the port scan and the checker. This is **not** the required independent review; re-run it when quota allows. |

## M1 exit criteria — lab evidence (four-node container lab)

| Scenario | Verdict | Numbers |
|---|---|---|
| `single-node-gate` | **pass** | 2,675 requests, 0 failures outside the redeploy; 2×503 while the only copy restarted; 0 lost writes |
| `kill-node`, edge bypassed | **pass** | offline at 33 s; re-placed copy answering at 124 s (bound 240 s); 0 lost writes |
| `kill-node`, through the edge | **fail** | offline at 28–29 s; copy re-placed and running, but the edge never sends it traffic; 0 lost writes |
| `freeze-agent` | **fail** | 0 of 17 database health probes answered during the 60 s freeze; no restart, no re-placement |
| `attachments-three-nodes`, container | **skip** | the platform refuses to spread a container to a database's other node on the integrated tree (should pass with W4; re-run) |
| `attachments-three-nodes`, process | **fail** | promotion took 58 s; all 3 copies changed env and restarted; 916 failed requests; 0 lost writes |
| `rolling-deploy-under-load` | **fail** | 10,020 requests a minute; rollout done in 39.5 s; 3 of 30,061 requests not 2xx; release-command parts skipped |

So **M1 is not met**: one criterion (kill a node, checker clean) fails only on the edge path, and
the no-failed-request deploy misses by 3 requests. W3's Azure half also has a known blocker.

### Platform bugs the lab found (not fixed in Wave 1)

1. A copy re-placed by failover enters the edge's upstream list only on the next unrelated
   desired-state change; its move to `running` does not bump the version.
2. The cross-node database forwarder runs in the agent: freezing or restarting the agent cuts
   every remote copy on that node off from Postgres (matters for H24/S10 and W11).
3. G10 is wider than the plan: a manual promotion restarts every consumer, not only those on the
   old or new primary's node.
4. A workload has no copy id, so checker I15 cannot attribute a late request to a copy; W5 drain
   needs something like `YOAL_COPY_ID`.
5. A protected-route health check was not exercised (no scenario uses one).

## What the work proved wrong in the plan

- The Wave 1 lane B work was largely in the foundation branch's hot files by the time lanes
  started; the split plus foundation did more than stubs, so B's remaining surface was smaller
  than the table implied.
- The migration reservation `0121` was never used by A, so B's `0122` had to be renumbered to
  `0121` to keep the stream contiguous. Future waves should number at merge time, not at lane
  start.
- `databaseHostAlias` and `databaseAlias` had diverged in the foundation contract; the tests used
  the wrong one. The alias is now one definition.
- The contract comment said an expired lease is "re-leased"; it is not (it becomes `timeout`).
- The canary's "quiet app" rule needs the baseline quiet too; a silent canary with a busy
  baseline is a window-loss, not a pass (open C finding).
- The W3 exit needs the helper (Litestream/pgBackRest) and presign-header contract changes; the
  core-only lane cannot close it alone.

## Wave 1 residual gaps (owner decisions)

1. **Azure presigned uploads** (E blocker): `ObjectStore.presignPut` returns a URL only. Fix in
   Wave 3 with the arbiter work or before W10's Azure restore drill.
2. **Multi-org gateway address** (A): one gateway per node cannot serve several org bridges. Needs
   a per-network gateway list or a shared pinned endpoint network.
3. **Readiness ordering** (D/C): the edge adds an upstream before it is ready unless the agent
   reports ready first; document/gate it in the rollout.
4. **Canary window loss** (C): a control-plane restart mid-canary can pass on readiness; require
   the baseline to be quiet too.
5. **Operator retry** (C): no REST/CLI surface for "retry a failed release command" yet.
6. **Lab evidence**: the four-node run is recorded above; the three failures are tracked as the
   platform bugs above and are Wave 2/M2 fix candidates (the edge upstream bump is the first).

## S10 outcome (forwarder decision)

S10 chose the **Bun forwarder with the restart fix** over caddy-l4: caddy-l4 fails all listeners when
one gateway address cannot bind, couples every endpoint edit to a sites reload, and needs a new Caddy
module; the Bun forwarder already has pinned mTLS. Numbers are in `docs/SPIKES.md` (S10).

Already covered by the merged Wave 1 code:
- the reload bug S10 found (stored vs compared signature mismatch) is gone — the forwarder now
  updates in place and does not restart unchanged listeners;
- a failed gateway bind is retried with backoff instead of logged once;
- the endpoint guard drops other orgs and the underlay, and the gateway binds only after it is applied.

Still open, and now recorded here:
- **Pin the org network subnet.** Podman allocates `10.89.N.0/24` in creation order; recreating a
  network can move it (S10 measured 10.89.1.0 → 10.89.3.0), which breaks `AddHost` and any
  hard-coded gateway address. The network unit should render `Subnet=`, or the control plane should
  allocate it.
- **One gateway address cannot serve several org bridges.** This is the same gap the lane A review
  found: the contract carries one `gatewayAddress` per endpoint. A node with two org networks needs a
  per-network gateway (list) or a shared endpoint network with a pinned subnet.
- **`nf_conntrack_max`.** Each endpoint connection leaves two entries for 120 s; the default 65,536
  filled at 100k connections and dropped SYNs. Nodes need it raised.
- **`net.ipv4.ip_nonlocal_bind=1`.** A forwarder started before its bridge exists cannot bind until
  the retry; the sysctl removes the race.
- **RSS budget.** About 20–45 MB more for the agent at 200 routes (35 MB idle, 57 MB under load).
- The 24 h soak and a real WireGuard hop are still owed to the lab/weekly job.
