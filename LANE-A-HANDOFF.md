# Lane A handoff — W9 control-plane standby and arbiter

Worktree: `/Users/kieranholroyd/.t3/worktrees/private-cloud-deploys/t3-w3-a-control-standby`
Branch: `ha/w3-a-control-standby` (base `main`, no merge performed)
Implementation commits: `924a4b46` (machine), `f305bf26` (review blockers 1–3), then the review-fix commit on top
Spec: `docs/build-plan/W9-SPEC.md` Revision 1 (not changed)

## 0. Independent-review fixes (second pass)

`REVIEW-FINDINGS.md` blockers 1–3 were already fixed by `f305bf26`; this pass closes the rest:

| # | Fix |
|---|---|
| 4 | `ControlLease.operatorTakeOver()` applies the same expiry + 40 s unchanged-object gate as an automatic takeover; `--break-glass` is the explicit §18.5 path and is still a CAS. `expectedEpoch` is compared with the record read for that CAS. |
| 5 | Automatic takeover is gated on enrolment evidence, not the static role hint; an enrolled node whose hint still says `primary` can win a later term. |
| 6 | `yoal ha control enrol --open <file> --code <code>` unseals, verifies the master-key fingerprint and config digest, writes `master.key` 0400, merges `yoal.env` 0600 and writes `ha-control-enrolment.json` 0600. Promotion is refused without the record. |
| 7 | `--out` writes `{ bundle, certificate }`; the activation code is printed only. The standby `--open` accepts the wrapped file. |
| 8 | The co-located agent reads its own `/readyz` (`YOAL_CONTROL_LOCAL_URL`, or `controlUrl/readyz` through `YOAL_CONTROL_SOCKET`) and reports `control` in the heartbeat, so status shows standbys. |
| 9 | `ControlLeaseStatus.reachable` distinguishes a failed read from a graceful role; a standby with an unreachable arbiter becomes `unavailable` after 30 s, and the error timer resets only on a successful read. |
| 10 | `YOAL_CONTROL_ADDRESSES` is `nodeId=url` pairs; desired state binds by node id, so holder-first reordering cannot swap URLs. |
| 11 | Bootstrap and takeover use `max(observed, durable) + 1`; the epoch file is written as `max(onDisk, epoch)` and the runtime starts from the durable baseline. |
| 12 | `/readyz` sets `ok` from the final status line, so a 503 body never says `ok: true`. |
| 13 | `--expect-epoch` checks the just-read lease record (new `operatorTakeOver`), not the cached epoch. |
| 14 | An unknown `YOAL_CONTROL_ROLE` is a configuration error; only `primary`/`standby` are accepted. |
| 16 | The standby test asserts the lease body still names the primary at the same epoch, not just `200`. |

New tests cover each fix, including a 5,000-schedule W9 run and the flag-off desired-state golden.

## 1. Verified

| Command | Result |
|---|---|
| `bun run check` | every workspace package exited 0; `iam lint` baseline unchanged. One pre-existing Svelte warning in `settings/registry/+page.svelte`. |
| `bun test` | **6493 pass, 74 skip, 0 fail** (6567 tests, 594 files, 192 s). |
| `bun test tests/ha/sim/w9` | 16 pass, 0 fail. |
| `bun tests/ha/sim/w9/run.ts --runs 5000` | 5,000 schedules, 0 violating runs, ~8 s; all families including `control-outage`, `stale-leader`, `sync-change`. |
| Focused W9 tests (12 files) | lease, standby, service, config, desired-state control, enrolment, CLI standby enrolment, agent report, arbiter and contracts pass. |
| `bun test packages/core/src/desired-state/golden.test.ts` | pass; flag-off desired state is byte-identical (single-node gate's static half). |
| `bun run check:migrations` | ok, 126 migrations; **no 0127 added**. |
| CI | `.github/workflows/ha.yml` `ha-sim` now runs the W9 model (`--runs 5000`) and its unit tests. |

The one full-suite first-run failure was `apps/cli/src/commands/email.test.ts` under parallel load; it passed alone (15/15) and on the full rerun (0 failures). Not related to this lane.

## 2. Not verified, and why

- **Single-node gate** (`tests/ha/scenarios/single-node-gate.ts`) — needs the Docker lab; not runnable in this environment. Its flag-off desired-state assertion is covered by the golden test; the deploy/scale/redeploy half is for the integrator.
- **24 h control-plane outage soak (I11)** — needs the lab and a day. The deterministic `control-outage` family (500 runs) and the agent cached-state/rotation tests are the evidence available here.
- **Real S3/R2, Azure and GCS conditional writes** — the arbiter adapter and CAS mapping are unit-tested against the in-memory store; the backend conformance suites from the foundation were not re-run against live emulators.
- **Real restore/follow of the control SQLite replica** — this lane consumes `<dataDir>/ha-control-replica.json`; the Litestream restore/follow automation is not in this tree. Without that file a standby stays `joining` and `canPromote:false`.
- **End-to-end promotion on two hosts** — no owner fleet, DNS or keys were touched, per the brief.
- **Mixed-version agent** — the gate unit test covers stripping `control`/`platformUpstreams`; no old agent binary was run.
- **Dashboard enrolment UI** — owner-gated; the CLI/API ceremony is implemented and audited.
- **Standby status in the primary's `/api/v1/ha/status` from a separate host** — the agent now reports `control` from its local `/readyz`, but the two-host end-to-end path (socket/loopback URL, heartbeat, status row) needs the fleet lab. The parser and mapping are unit-tested.

## 3. Deviations

1. **No migration 0127.** Not needed: `0125` already provides `nodes.ha_epoch` and `control_state`; the per-host enrolment/epoch/replica records are 0600 files (`ha-control-enrolment.json`, `ha-control-epoch.json`, `ha-control-replica.json`), not schema.
2. **`/api/v1/ha/status` is additive, not replaced.** It keeps the failover document and adds `controlPlane` only while the flag is on. Promotion/enrolment use new routes `/api/v1/ha/control/promote` and `/api/v1/ha/control/enrol`. No existing CLI/dashboard caller breaks.
3. **`ControlLease.probe()` added** (additive to `ha-lease.ts`): a read that does not change the role, used so a fenced node cannot mistake an unreachable arbiter for a stable holder and rejoin.
4. **Fenced rejoin follows W9-SPEC §4.3** (automatic after 5 s with another holder reachable and replay current), which is looser than CLUSTERING §6.3's "does not resume automatically". Safety is unchanged: rejoin is standby-only and a new term still needs a fresh 40 s-quiet CAS. This is a **tension between the two documents**, not a change to W9-SPEC. The integrator should confirm the reading.
5. **Platform upstream peers use `<overlay>:8080` plain HTTP.** Caddy has no per-upstream TLS transport, so mixing a local unix socket with HTTPS peers in one `lb_policy first` list would break the fallback. The node's own socket is first; peers are reached over the overlay's plain ingress listener, which is the existing W6 relay convention. An agent/ingress without an overlay address gets only its own socket.
6. **Agent control addresses are declared per node.** `YOAL_CONTROL_ADDRESSES` is now `nodeId=url` pairs and desired state binds by node id, falling back to the platform origin. The tree still has no per-node direct listener (the control plane listens on a unix socket behind the ingress), so the contract's list is usually one origin until the operator declares `nodeId=url`.
7. **Operator promotion has an explicit `--break-glass`.** The ordinary `yoal ha control promote` uses expiry + the 40 s quiet window; `--break-glass` is the audited §18.5 recovery path and still CASes at the read ETag. This matches CLUSTERING §6.5/§18.5 and does not change W9-SPEC.
8. **The co-located agent reports `control` only when it has a local path.** `YOAL_CONTROL_LOCAL_URL` (or `controlUrl/readyz` through `YOAL_CONTROL_SOCKET`) is read; a worker never reports another node's role. An agent without either omits `control`, as before.
9. **Enrolment second factor = the session's step-up class (`strong`).** The API refuses API keys/MCP tokens with no step-up state. The certificate is signed by the install CA, so `ENDPOINTS_GATEWAY` must be on; otherwise enrolment refuses with a named prerequisite instead of issuing an unsigned certificate.
10. **`control_state` is written only by a serving primary.** A standby must not write its followed SQLite; its live status is served from memory by its own API.
11. **Agent capability `ha-epoch` is now advertised.** The gate strips `control` and `ingress.platformUpstreams` from older agents, so their strict schemas do not see unknown fields.

No spec change is requested. The one open reading is network topology for direct control addresses (item 6).

## 4. Files of record

- Lease/store: `packages/core/src/ha-control-arbiter.ts`, `packages/core/src/ha-lease.ts` (`operatorTakeOver`, `reachable`, `durableEpoch`).
- Machine: `packages/core/src/control-standby.ts`; service wiring `control-plane-service.ts`.
- Enrolment: `packages/core/src/control-enrolment.ts`; CLI standby half `apps/cli/src/control-enrol.ts`; runbook `docs/HA-CONTROL-STANDBY.md`.
- Agent: `apps/agent/src/control-endpoints.ts`, `control-report.ts`, `main.ts`; Caddy `apps/agent/src/caddy-config.ts`.
- Contracts: `packages/contracts/src/{control-plane,agent,ingress,failover}.ts`.
- Desired state: `packages/core/src/desired-state/control.ts`, `ingress.ts`, `capability-gate.ts`.
- HTTP: `apps/control-plane/src/{hooks.server.ts,routes/readyz/+server.ts,routes/api/v1/ha/...}`.
- CLI: `apps/cli/src/{commands/ha.ts,ha.ts,api.ts,main.ts,control-enrol.ts}`.
- CI: `.github/workflows/ha.yml`.

## 5. Final SHA

The handoff file is committed on top of the review fixes; `git rev-parse HEAD` in the worktree is
authoritative.
