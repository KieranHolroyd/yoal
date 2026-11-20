# Lane A handoff — W9 control-plane standby and arbiter

Worktree: `/Users/kieranholroyd/.t3/worktrees/private-cloud-deploys/t3-w3-a-control-standby`
Branch: `ha/w3-a-control-standby` (base `main`, no merge performed)
Implementation commit: `924a4b46fe9d4289423df381d93624bd961f98c2`
Spec: `docs/build-plan/W9-SPEC.md` Revision 1 (not changed)

## 1. Verified

| Command | Result |
|---|---|
| `bun run check` | every workspace package exited 0; `iam lint` baseline unchanged. One pre-existing Svelte warning in `settings/registry/+page.svelte`. |
| `bun test` | **6475 pass, 74 skip, 0 fail** (6549 tests, 592 files, 210 s). |
| `bun test tests/ha/sim/w9` | 16 pass, 0 fail (0.8 s). |
| `bun tests/ha/sim/w9/run.ts --runs 5000` | 5,000 schedules, 0 violating runs, ~10 s; all families including `control-outage`, `stale-leader`, `sync-change`. |
| Focused W9 tests (10 files) | 79 pass: `control-standby`, `ha-control-arbiter`, `control-enrolment`, `control-plane-service`, `desired-state/control`, `ha-wave1-foundation`, agent `control-endpoints`, agent `capabilities`, CLI `ha`, site-config. |
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
- **Standby status in the primary's `/api/v1/ha/status`** — the primary writes its own `control_state` row and accepts `control` in heartbeats, but the control node's agent does not yet populate that heartbeat field. Query the standby directly for its live view.

## 3. Deviations

1. **No migration 0127.** Not needed: `0125` already provides `nodes.ha_epoch` and `control_state`; the per-host enrolment/epoch/replica records are 0600 files (`ha-control-enrolment.json`, `ha-control-epoch.json`, `ha-control-replica.json`), not schema.
2. **`/api/v1/ha/status` is additive, not replaced.** It keeps the failover document and adds `controlPlane` only while the flag is on. Promotion/enrolment use new routes `/api/v1/ha/control/promote` and `/api/v1/ha/control/enrol`. No existing CLI/dashboard caller breaks.
3. **`ControlLease.probe()` added** (additive to `ha-lease.ts`): a read that does not change the role, used so a fenced node cannot mistake an unreachable arbiter for a stable holder and rejoin.
4. **Fenced rejoin follows W9-SPEC §4.3** (automatic after 5 s with another holder reachable and replay current), which is looser than CLUSTERING §6.3's "does not resume automatically". Safety is unchanged: rejoin is standby-only and a new term still needs a fresh 40 s-quiet CAS. This is a **tension between the two documents**, not a change to W9-SPEC. The integrator should confirm the reading.
5. **Platform upstream peers use `<overlay>:8080` plain HTTP.** Caddy has no per-upstream TLS transport, so mixing a local unix socket with HTTPS peers in one `lb_policy first` list would break the fallback. The node's own socket is first; peers are reached over the overlay's plain ingress listener, which is the existing W6 relay convention. An agent/ingress without an overlay address gets only its own socket.
6. **Agent control addresses default to the platform origin** unless `YOAL_CONTROL_ADDRESSES` names direct endpoints. This tree has no per-node control listener (the control plane listens on a unix socket behind the ingress), so the contract's list is populated but usually one origin until the operator declares direct addresses.
7. **Enrolment second factor = the session's step-up class (`strong`).** The API refuses API keys/MCP tokens with no step-up state. The certificate is signed by the install CA, so `ENDPOINTS_GATEWAY` must be on; otherwise enrolment refuses with a named prerequisite instead of issuing an unsigned certificate.
8. **`control_state` is written only by a serving primary.** A standby must not write its followed SQLite; its live status is served from memory by its own API.
9. **Agent capability `ha-epoch` is now advertised.** The gate strips `control` and `ingress.platformUpstreams` from older agents, so their strict schemas do not see unknown fields.

No spec change is requested. The one open reading is network topology for direct control addresses (item 6).

## 4. Files of record

- Lease/store: `packages/core/src/ha-control-arbiter.ts`, `packages/core/src/ha-lease.ts` (`probe`).
- Machine: `packages/core/src/control-standby.ts`; service wiring `control-plane-service.ts`.
- Enrolment: `packages/core/src/control-enrolment.ts`; runbook `docs/HA-CONTROL-STANDBY.md`.
- Agent: `apps/agent/src/control-endpoints.ts`, `main.ts`; Caddy `apps/agent/src/caddy-config.ts`.
- Contracts: `packages/contracts/src/{control-plane,agent,ingress,failover}.ts`.
- Desired state: `packages/core/src/desired-state/control.ts`, `ingress.ts`, `capability-gate.ts`.
- HTTP: `apps/control-plane/src/{hooks.server.ts,routes/readyz/+server.ts,routes/api/v1/ha/...}`.
- CLI: `apps/cli/src/{commands/ha.ts,ha.ts,api.ts,main.ts}`.
- CI: `.github/workflows/ha.yml`.

## 5. Final SHA

`924a4b46fe9d4289423df381d93624bd961f98c2` (implementation). The handoff file is committed on top; `git rev-parse HEAD` in the worktree is authoritative.
