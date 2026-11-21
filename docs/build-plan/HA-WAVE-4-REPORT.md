# HA Wave 4 report — unplanned failure is survivable (M4)

Plan: [HA-PLAN.md](../HA-PLAN.md) §5 wave 4, §6.4, §6.5. Releases: `0.16.9` (foundation), `0.16.10`
(W15), `0.16.11` (W11). `VERSION` is `0.16.11`.

## Gate

- `bun run check`: 0 errors (one pre-existing Svelte warning).
- `bun test`: **6903 pass / 74 skip / 0 fail** on the integrated tree.
- W11 model: 5,000 schedules, 14 families, **0 violations** of I3/I11/I12/I13; time-to-writable
  median 18.5 s, judged worst 30.0 s; canonical fixed two-fault case **0 seeds over 30 s** (worst
  28.1 s) with a delivered fence notice; no-delivery paths are slower (median 30.8 s, worst 33.1 s),
  alerted, and safe.
- W9 model still 5,000 schedules / 0 violations.
- Flag-off desired state byte-identical; migrations `0125`–`0130` contiguous, no `0131`/`0132` used.
- `DB_AUTO_PROMOTE` remains **off**.

## What landed

- **Foundation:** per-database failover policy (mode, `acceptDataLoss`, arming/drill evidence, stable
  refusal codes), member-report arbiter/lease/keep-alive truth, SLO/prober contracts, migrations
  `0129` (policy/evidence) and `0130` (drills/SLO objects), honest read services and loud stubs.
- **A (W11):** shared failover machine (candidate rules, Rev-4 fence-notice validation and waivers,
  promotion body, re-arm, consumer selection, reader reconciliation, time-to-writable); real
  arming/disarming/drills with every refusal and measured evidence; per-database auto gate; agent
  member machine (monotonic debounce, arbiter-clock expiry for the node path, sync eligibility,
  keep-alive block, generation-keyed notice emit/consume, CAS `gen+1`, fence-before-notice with a
  fresh 2 s window, retry after a failed promote); control-plane reader that never decides or lowers
  a generation, re-attaches the old primary, audits both two-primary paths; `source: 'auto'`.
- **B (W15):** SLO objects with error budgets and multi-window burn alerts; external prober (Bearer
  token hashed at rest, sequence/install binding, rate/body caps, 404 with the flag off); 
  `ha.effective_below_target`; failover/drill timeline; authenticated-only HA/lease/steering metrics;
  `ha` system-alert kind routed and mutable; orphan SLO purge.

## Reviews

Every lane was independently reviewed; the safety-critical lane went through three rounds. The
review caught and the fixes closed:

- an install path that could re-enable the old control-plane controller without any node fencing
  (zero data-role nodes), and an `active` flag that omitted cluster `failover.enabled`;
- promotion passing the database id instead of the replica workload id;
- the fence notice measured before a 20 s fence, so it was always missed;
- an unsafe fence-then-notice ordering, fabricated drill evidence (`arbiterTested`, lost commits),
  wall-clock safety timers, a `changing` lease left with no promoter, stale `observedAt`, control
  plane lease resurrection, and post-promotion `clearSync`/`fence` against a non-existent id;
- W15: an unreachable prober endpoint (CSRF/auth), orphan SLOs alerting after project purge, and
  tenant names in the public `/metrics` (new HA series now authenticated-only; docs corrected), plus
  the unreachable `ha` alert kind.

## What is still report-only (must be stated plainly)

- The agent has **no arbiter transport or mTLS peer channel**, so it advertises no
  `db-member-self-fencing` capability. This build installs no automatic path; `auto` arming is
  refused with `no-self-fencing-path`. `DatabaseMemberRunner` is report-only.
- Consumer discovery (`consumerTarget`) is implemented and fail-closed, but not wired into
  `ServiceForwarder`; apps keep the desired-state upstream and restart-free swap. With the control
  plane down, writes fail closed rather than follow a new primary.
- The model checks generation/holder/epoch and best-effort delivery, not mTLS/signature
  authentication, the control-plane reader, or the controller path.

## M4 evidence still owed

1. Kill the database primary's node **20 times** per §7.2 scenario: writable ≤ 30 s, RPO 0 in
   `sync` — needs the real fleet and the arbiter/peer transport above.
2. Arbiter outage alone causes no failover and no stop; two-data-node `auto` refuses — the model
   covers these, the lab does not.
3. Prosecutors (network/process/clock) after the transport lands.
4. 24 h random-fault soak with the checker.

## Residual gaps

- W11's node machine needs the arbiter/peer transport design (no secrets in desired state) and the
  forwarder wiring before `auto` can be enabled.
- `acceptDataLoss` for `async` is modelled but no lab run; `on_sync_loss: block` outside the
  implementation.
- W15: live prober run, real ClickHouse windows, browser pass of the SLO page, database lease
  **expiry** not exported (freshness only), some indicators have no evaluator.
- Manual/operator promotion and the controller path are outside the model.

## Wave 5 opening (proposed)

Foundation PR 5: regions, blueprint keys, drill catalogue and the `ha` profile; lanes W13 (regions/DR),
CLI `ha` commands, blueprint, dashboard setup, Terraform/cloud-init per cloud, and the docs pipeline.
M5 remains five commands from empty machines in 30 minutes.
