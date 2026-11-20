# Lane E hand-off — remaining W8 drivers (`vip`, `webhook`)

Branch: `ha/w3-e-drivers`, base `main` (`0b187500`). Worktree:
`/Users/kieranholroyd/.t3/worktrees/private-cloud-deploys/t3-w3-e-drivers`.
Final commit: `<filled after amend>`.

## Verified

- `bun run check` — every workspace check passed (13 packages/apps; control-plane 0 errors,
  1 pre-existing Svelte warning), plus `iam lint: no new role/kind checks`.
- `bun test` — full suite: **6496 pass, 74 skip, 0 fail** (6570 tests, 589 files).
- Both drivers pass the shared `describeSteeringConformance` suite and
  `steeringConformanceCases`, with driver-specific cases:
  - `vip`: exactly one MASTER at priority 150, every other serving node at 100, one floating
    address, two applies write nothing the second time, and no VRRP password in `observe()`.
  - `webhook`: every request has a verifiable `x-yoal-signature` over the raw body, the secret is
    absent from the body and every view, and an acknowledgement cannot empty the serving set.
- Last-healthy refusal:
  - `vip` keeps the previous intended set when every probe fails and never issues the stop that
    would leave zero keepalived nodes.
  - `webhook` keeps the previous set on a failed delivery, and refuses an acknowledgement with an
    empty/unknown `serving` list.
- Webhook HMAC:
  - `signWebhookBody` / `verifyWebhookSignature` (the existing Stripe-style scheme) are reused;
    correct secret verifies, a wrong secret does not.
  - Sealed secret: `setWebhookSettings` writes only `secretSealed` to `settings`; the test asserts
    the plaintext is not in the row. `createWebhookDriverFromCore` opens it per request.
- Keepalived config rendering (helper tests):
  - one fixed `vrrp_instance`, unicast peers, `auth_pass`, floating `/32`;
  - no `vrrp_script`, `notify_*` or `track_*` lines;
  - injection attempts through instance/interface/VIP/auth/priority/router-id and unknown keys
    are rejected;
  - config written atomically 0600; `install` enables, `configure` reloads only when active and
    changed, `start`/`stop` use the fixed service name, and no shell is involved.
- Flag-off path: with `STEERING` off, selection is `direct` for a stored `webhook`/`vip` choice and
  no helper call or HTTP request is made.
- `direct`, `external-lb`, the single-node gate and the site-config golden are unchanged.
- No migration: configuration reuses the `settings` table under `ha:steering_vip` and
  `ha:steering_webhook`; migration `0131` is **not** used.

## Not verified

- No real keepalived/VRRP run: failover timing (the 3–5 s bound), address movement between hosts,
  L2 adjacency, or interaction with a real distribution's `keepalived.service` was not exercised.
  Lab timings belong to the lab lane.
- No real operator endpoint: only an in-process fake fetch. TLS, proxy behaviour, clock skew
  tolerance and a real acknowledgement receiver were not tested.
- No real helper socket: `HelperVipControl` was exercised with a fake `VipControl`; the unix-socket
  transport and its `unix` fetch option were not run against a helper process.
- No cloud/balancer run and no DNS changes (out of scope for this lane).
- No long-soak or 24 h scenario.

## Deviations and notes

- **VIP helper transport is explicit.** The control plane cannot reach a remote node's helper
  socket without a mounted path, so `createVipDriverFromCore` uses the injected
  `config.vipControl` or `YOAL_VIP_HELPER_SOCKETS` (node id/name → socket path). A node with no
  entry is refused by preflight with one reason per node instead of being silently left out of the
  VRRP group. A future agent-relayed transport can replace the seam without changing the driver.
- **`install` means render + enable, not apt.** The fixed verb writes `/etc/keepalived/keepalived.conf`
  0600 and runs `systemctl enable keepalived.service`; installing the OS package remains an image
  prerequisite. No package manager is invoked by the helper (no shell, no widened privileged
  surface). `configure` writes the same file and reloads an active unit.
- **Webhook acknowledgement contract:** `2xx` plus JSON `{ "accepted": true }`. Optional
  `serving: string[]` may narrow the set but may not name unknown nodes or leave no healthy ingress.
  Any other field is refused. The request body is `{ version, kind, sentAt, ingress: { healthy,
  serving, healthPath, drainSeconds, nodes } }`; `sentAt` is excluded from the idempotence
  fingerprint so an unchanged set is sent once.
- **`webhook` probes are declared `external`** (the operator's system observes traffic); `vip`
  declares `yoal` (the controller snapshot/probe decides priorities). `direct` is untouched.
- **Shared files touched:** `packages/core/src/config.ts` (injected `vipControl`/`webhookFetch`),
  `packages/core/src/index.ts` (core adapters), `packages/core/src/ingress-service.ts`
  (`driverContext()`, node address in the snapshot), `packages/core/src/steering/{registry,
  snapshot,types,conformance-cases,conformance-cases.test,conformance.test,steering-service.test}.ts`.
  No lane A/B/C/D implementation files were touched; no spec text changed.
- The registry now lists `direct`, `external-lb`, `vip`, `webhook`; `dns-failover` remains a
  context-backed adapter registered in `index.ts`, and `cloud-lb`/`cloudflare-tunnel` remain
  unimplemented and fail selection with a reason.
