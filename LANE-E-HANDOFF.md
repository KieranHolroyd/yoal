# Lane E hand-back — W8 `dns-failover` (Cloudflare)

Branch `ha/w2-e-dns`, base `ha/integration` at `416996dd` (Wave 2 foundation). No merge to main,
no VERSION bump, no migration. The old `LANE-E-HANDOFF.md` (Wave 1 object stores) is replaced by
this file; that work is already merged and has its own history.

## 1. What ships

`packages/core/src/steering/` is new and owns the whole driver:

- `dns/provider.ts` — the provider plugin boundary: list A/AAAA at a name, create, update, delete,
  and a typed failure that says whether a retry can help.
- `dns/cloudflare/provider.ts` — the Cloudflare v4 implementation. Token only in the
  `Authorization` header, injectable `fetch` and timeout, zone by id or resolved by name once, and
  the proxied-record rule that Cloudflare only accepts TTL 1. No credential is read at import time.
- `dns-failover/health.ts` — pure probe state: 45 s hold-down, doubled to 90 s without corroboration
  from another zone (or a replicated `offline` for 2 minutes), a success in the last 10 s restarts
  the streak, 120 s re-add hold-down, last-healthy refusal, and disagreement reporting.
- `dns-failover/probe.ts` — `GET https://<address>/.well-known/yoal/health` with the probed node's
  `Host`/SNI, 3 s timeout, `200` + `{"status":"ok"}` only. A draining 503 is a failed probe.
- `dns-failover/driver.ts` — the `SteeringDriver` plus `apply({epoch, holds})`. It probes, decides,
  persists the intended set before any API call, reconciles every managed name, records an event per
  provider change, and retries 5/15/45/60 s. `desired()` is read-only, because a write without a
  lease would violate H18.
- `dns-failover/core.ts` — the `CoreContext` adapter: ingress set and addresses, managed record
  names (content apex, one-level wildcard, platform host), `ha:ingress_rotation` state (the same key
  the C5 status view already reads), and `failover_events` rows (`kind: 'ingress'`,
  `stage: 'repoint'`, the lease `epoch`).
- `conformance.ts` — the shared steering suite. `direct` and `dns-failover` both run through it;
  lane D adds `external-lb` under the same hooks.

Wiring (all additive):

- `SteeringService` takes `SteeringServiceOptions.drivers`; `dns-failover` is registered there only
  when `STEERING` is on. Lane D's `external-lb` should register under the same option key.
- `FailoverService` calls the driver's `apply()` only while it holds the controller lease, after the
  existing `#ingressTick`, and skips the old heartbeat-only rotation path for `dns-failover` when
  `STEERING` is on. Flag off is byte-for-byte the old `manual` path.
- `CoreConfig` gained `dnsProvider` and `ingressProber` injection points so tests never touch a
  token, a zone or the network.

## 2. Verified

All commands in `/Users/kieranholroyd/.t3/worktrees/private-cloud-deploys/t3-w2-e-dns`.

| What | Command | Result |
|---|---|---|
| Types, every package | `bun run check` | all packages `Exited with code 0`; control-plane `svelte-check found 0 errors and 1 warning` (pre-existing `settings/registry` warning); `iam lint: no new role/kind checks` |
| Full suite | `bun test` | **6311 pass, 74 skip, 0 fail**, 44,643 expect calls, 6,385 tests in 574 files (199.7 s + 237.7 s in two green runs; one intermediate run had a single non-reproducing failure outside this lane) |
| Focused driver suite | `bun test packages/core/src/steering` | **46 pass, 0 fail** across 5 files (provider, health, driver, conformance, controller integration) |
| Failover controller regression | `bun test packages/core/src/failover-service.test.ts` | 25 pass, 0 fail; the C5 manual path still passes with `STEERING` off |
| Single-node gate | `bun tests/lab/lab.ts up --only lab-a` then `bun tests/ha/scenarios/single-node-gate.ts --duration-s 150 --rate 20 --seed 1` | **PASS**, 3,001 requests / 2 failed (two 503s inside the redeploy window, allowed ≤ 5), 0 lost acknowledged writes, 0 duplicate singleton runs, 2,675 requests outside the redeploy with 0 failures, longest write gap 0.3 s |

Behaviour asserted by the focused tests:

- **Record-set reconciliation**: absent records are created, missing ones are re-created, strays at
  a managed name are deleted, a drifted TTL is corrected, and a proxy-state mismatch is refused
  (event + critical alert, no write).
- **Duplicate writes**: a second `apply()` with an unchanged set performs zero provider writes and
  adds no events.
- **Quorum/hold-down**: one witness waits 90 s; a corroborating zone withdraws at 45 s; same-zone
  reports are not corroboration; an offline status corroborates after 2 minutes; a success resets
  the streak; a success inside 10 s pushes the streak forward.
- **Last healthy**: with every node failing, nothing is withdrawn and the provider still has the
  record set; a failed node is removed only while a healthy record remains.
- **API failure/timeout**: a failed delete leaves the provider set untouched, records a `failed`
  event and the `steering:dns-failover:api` alert, then succeeds on the 5 s retry.
- **Re-add and pin**: 120 s of health re-adds; a second withdrawal inside 30 minutes pins for
  30 minutes even after the readd hold-down.
- **Lease**: no lease means no state write, no provider write and no event; a lease lost
  mid-reconcile stops the next write and reports `fenced: true`; `desired()` writes nothing.
- **Preflight**: one ingress, a missing provider, an empty address, a non-hostname managed name and
  an offline node each produce a finding.
- **Controller integration**: `STEERING` on writes six records for two nodes × three names, every
  row lands in `failover_events` at the controller epoch, the status view shows the withdrawn node
  out of rotation, the last record survives a second failure, and `STEERING` off performs zero DNS
  writes while keeping today's single `manual` event.

## 3. Not verified (and why)

- **A real Cloudflare zone, token and API.** Every write went to a fake provider or a recorded/fake
  `fetch`. Zone lookup, `Zone:DNS:Edit` permissions, proxied TTL rules, 429 backoff and the real
  error envelope are only proven against the fake. No live DNS, no account, no spend.
- **Real DNS propagation and resolver caches.** The driver changes records; TTL expiry, resolver
  caching and Cloudflare's proxied-origin behaviour (52x for a dead origin) were not exercised. The
  plan's 120–240 s bound includes that window; this lane's half is 45/90 s of hold-down plus a 10 s
  probe interval, which is inside it, but the end-to-end time was not measured.
- **Real probe TLS.** `httpIngressProber` sends the node address with the platform `Host`/SNI and a
  3 s timeout; the fake prober returns observations directly. A real node certificate and the Bun
  `tls.serverName` path need the lab with two ingresses and public addresses.
- **Corroboration from another zone's real heartbeat reports.** The pure health state and the driver
  accept a second observer; no agent currently reports probe results in the heartbeat, so production
  runs `single-witness` (90 s) until that report exists. That is a Wave 3/external-lb integration
  point, and the alert key `steering:dns-failover:single-witness` makes it visible.
- **The 24 h observe-only migration** from `direct` (CLUSTERING §7.4 step 2) was not run. The driver
  writes every managed name it is given; the preflight does not yet read the zone to compare an
  existing set first.
- **Dashboard/REST/CLI surfaces** for the driver, its managed names, proxy choice, probe state and
  `yoal_ingress_*` metrics. Not in this lane's files; the services and alerts are ready for them.
- **Convergence preflight** (`actualStateVersion`, `caddyOk`, every release present, certificate
  fingerprint) is not checkable from this branch: those facts are not persisted on the node row yet
  (lane A/C). Preflight checks node count, zone, status, public address, provider and record names.

## 4. Deviations and dependencies

- **`dns-failover` depends on `INGRESS_SET`.** It publishes `IngressSetService.nodes()`, which is
  still the compatibility first ingress when `INGRESS_SET` is off. With the flag off the driver sees
  one ingress, preflight refuses, and it writes nothing. That is the correct safety property (a
  second node without the full payload would serve 404s), but the merge order must keep W6's
  `INGRESS_SET` ahead of this driver. The integration test turns both flags on.
- **No migration `0127`.** The intended set lives in the existing `ha:ingress_rotation` settings row
  (the C5 controller already reads it), and every DNS write is an existing `failover_events` row.
  `0127` was not used.
- **Managed names are derived, not configured.** Apex, `*.contentDomain`, platform host; proxied by
  default for the reference fleet and TTL 60. Two non-flag environment knobs,
  `YOAL_DNS_FAILOVER_PROXIED` and `YOAL_DNS_FAILOVER_TTL`, exist in the adapter until Settings →
  High availability owns them. The driver removes A/AAAA records at those names that do not belong
  to an ingress in the set, so these names must be dedicated to Yoal.
- **Proxy mismatch is a refusal per record, not a global preflight block.** The contract's
  `preflight()` is synchronous and cannot read the zone; the reconcile refuses the record, records a
  `failed` event and raises a critical alert, and never flips proxy state.
- **Events are recorded even if the lease is lost during the API call.** The provider call is gated
  by `holds()` immediately before it; once Cloudflare accepted a change, the row is written so the
  audit matches reality. A deposed controller cannot start a new change.
- **`SteeringService` seam.** `SteeringServiceOptions.drivers` is additive; lane D can register
  `external-lb` there without touching this driver. `FailoverService` calls the driver through a
  small `apply()` type guard; the contract's `desired()` remains read-only for every driver.
- **CoreConfig injection.** `dnsProvider` / `ingressProber` are for tests and embedders; production
  reads `YOAL_CLOUDFLARE_API_TOKEN` plus a zone id or name. No credentials are stored in the DB in
  this lane (the ACME holder/token custody is lane B's).
- No `VERSION` bump.

## 5. Final commit

- Code + tests + this hand-off: the tip of `ha/w2-e-dns`; SHA reported in the lane's final message.
