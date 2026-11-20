# Lane B hand-off — W7 certificates

Branch `ha/w2-b-certificates`, based on `ha/integration` `416996dd`.
Code commit `72594841415e080a884d1d5d46504c7da45aafd6`; this file is the commit after it (final SHA
in the message that delivered it). No merge to `main`, no VERSION bump, no real DNS or cloud
credentials used.

## What this lane ships

- **`CertificateService`** (`packages/core/src/certificates/service.ts`, re-exported from
  `ingress-service.ts`): `fingerprint()`, `leaseFor()`/`claimLease()`/`renewLease()`/`releaseLease()`,
  `relaysFor()`, `distribute(nodeId)`, `ingest()` (holder upload), `uploadByo()`, `remove()`,
  `requestReissue()`, `onIngressRemoved()`, `bootstrap()`, `sweep()`, `renewDue()`, `view()`,
  `report()`.
- **Custody.** The key is sealed with the platform master key into
  `ingress_certificates.key_sealed`. Every read path selects an explicit projection without that
  column; only `distribute()` opens it, for one ingress over the node-authenticated activation.
  Nothing is added to desired state.
- **ACME lease.** One row per host, 600 s TTL, 120 s renewal constant, one live holder; a second
  node gets `acquired: false` until expiry. Relay targets are derived from the holder's overlay
  address (`privateAddress`, else `publicAddress`) and `YOAL_ACME_CHALLENGE_PORT` (default 8089).
- **Distribution.** `GET /api/agent/certificates/activation` returns `{generation, fingerprint,
  certificates[], relays[]}`. The agent caches it 0600 and writes per-host pairs 0640, serves them
  through Caddy's standard `get_certificate http` manager at handshake time (S4 `B-hot` — no config
  reload on renewal), and reports `certificateFingerprint` in the heartbeat. The manager policy is
  first and carries a dead-end issuer so a failure never reaches a public CA.
- **Relay.** The agent renders a terminal route per leased host for
  `/.well-known/acme-challenge/*`, proxying to the holder over the overlay.
- **DNS-01 providers.** `DnsChallengeProvider` (`present`, `cleanup`, `sweep`) plus `cloudflare`
  (`Zone:DNS:Edit`; zone discovery, idempotent present, cleanup that throws, stale-record sweep).
  `azure-dns`, `route53` and `rfc2136` are declared and refuse with a clear message until their
  owners fill them.
- **Issuer.** `CertificateIssuer` + `LegoAcmeIssuer` (S4's measured client) behind
  `YOAL_LEGO_BIN`/`YOAL_ACME_EMAIL`/`YOAL_ACME_CA`; no issuer configured is reported as
  `skipped: no_issuer`, never a silent public-CA attempt.
- **Cold start.** `bootstrap()` names the content apex, its one-level wildcard, the platform host
  and verified custom domains; the maintenance sweep issues the ones with no row. BYO/ACME rows are
  respected, so an operator upload is never overwritten.
- **Reissue on removal.** Losing the `ingress` role, `setEdge` moving it away, or removing an
  ingress node sets `reissue_requested_at` on every live ACME certificate and drops that node's
  leases; the next sweep reissues. Compute-only node removal does not.
- **BYO.** Upload, distribute, never renew, alert at 30/14/3 days (`certificate:byo:<days>:...`).
- **Operator REST surface.** `GET/POST /api/v1/cluster/certificates`, `DELETE
  /api/v1/cluster/certificates/:host`, `POST /api/v1/cluster/certificates/:host/reissue`
  (platform-admin read/write as usual).
- **Migration 0123** (see deviations): `ingress_certificates.reissue_requested_at` and
  `nodes.certificate_fingerprint`.
- **Docs.** `docs/CLUSTERING.md` §7.3 now records the S4 outcome (control-plane issuer, hot swap,
  BYO, DNS providers, relay) rather than the `load_files` + reload text S4 disproved.
- **Single-node gate.** `SHARED_CERTIFICATES` added to the gate's HA flag list, so a gate run with
  it on is `invalid`, not a pass.

## Flag off

`enabled()` is false: `fingerprint()` is null, an activation is empty, `sweep()` is `skipped`, and
`report()`/`claimLease()`/`uploadByo()` write nothing. Desired state is untouched by this lane, so
it remains byte-identical; Caddy keeps the per-node ACME config compiled today (`bun test
packages/core/src/desired-state/golden.test.ts` unchanged and green). The agent's manager is null
and no relay route is rendered (covered by `apps/agent/src/caddy-config.test.ts`).

## Verified

- `bun run check` — every workspace, 0 errors; the only warning is the pre-existing
  `settings/registry/+page.svelte` Svelte warning outside this lane. `iam lint` clean.
- `bun test` — **6297 passed, 74 skipped, 0 failed** (6371 tests, 571 files, 217 s).
- `bun test tests/ha` — 66 passed; `node_modules/.bin/tsc -p tests/ha` clean.
- `bun scripts/check-migrations.ts` — ok; `packages/db/src/migrations.test.ts` 15 passed.
- New focused tests: `packages/core/src/certificates.test.ts` (22), `apps/agent/src/certificates.test.ts`
  (5), `apps/agent/src/caddy-config.test.ts` additions, `packages/contracts/src/ingress.test.ts`
  additions. They cover:
  - one lease per host, no steal before TTL, takeover after expiry, renewal keeps the token;
  - relay targets on the holder's overlay address, none for the holder or after expiry;
  - the sealed column is ciphertext and a view/JSON never contains the key; the activation does;
  - only the holder may upload; a mismatched key or wrong name is refused; a worker gets an empty
    activation, not an error;
  - two nodes get the same fingerprint, a forced renewal changes it on both;
  - BYO is distributed, never renewed, alerts at 30/14/3 with the right severity, and is skipped by
    `requestReissue`;
  - role removal (`nodes.update`) and compute-only removal behave as above; a fake issuer renews and
    the old pair survives a failed order with a 6 h retry;
  - cold-start bootstrap and BYO preservation;
  - Cloudflare present/cleanup idempotency, cleanup failure throwing instead of leaking, and the
    stale-record sweep; token from env/file;
  - the agent's 0600 cache/0640 pairs, cache reload with the control plane offline, wildcard
    handshakes, and the 30 s refresh cap;
  - the Caddy manager policy is first, has the dead-end issuer, the relay route is terminal and
    scoped to the challenge path, and the flag-off config has neither.

## Not verified (needs the lab, real DNS or a real CA)

- **The W7 exit numbers.** All ingress nodes reporting one fingerprint is proven at the service and
  agent level; the real fleet comparison and the "forced renewal drops ≤ 0.1% of 1,000 keep-alive
  connections" number were not measured. The delivery shape is S4 `B-hot` (which measured 0/1,000
  twice), but this lane did not re-run the rig.
- **Real ACME.** No order was placed. `LegoAcmeIssuer` is unit-tested with a stubbed exec; the
  release image does not yet install `lego`, and no Let's Encrypt/Cloudflare request was made.
  Cloudflare DNS-01, propagation and cleanup against a real zone are S4's numbers, not new ones.
- **HTTP-01 end to end.** The relay route and target are compiled and tested, but the holder-side
  responder that answers the relay is **not shipped**. DNS-01 (Cloudflare) is the configured path;
  HTTP-01 behind a balancer needs a challenge listener on the holder plus a lab pass.
- **Azure DNS, Route 53, rfc2136** — interface only; they refuse with a named error.
- **Activation over the real channel** on Linux (root:caddy ownership; this lane checked 0600/0640
  on macOS), and multi-control-plane lease behaviour (W9 owns the control-plane standby).
- **The single-node gate scenario** was not run (no lab); `bun test tests/ha` is the static part.

## Deviations from the brief/plan

1. **Migration 0123, not 0124.** `scripts/check-migrations.ts` requires a contiguous stream and 0122
   was the last file, so 0123 is the next free number (the Wave 2 table's "spare" numbers are
   claims). It adds exactly two columns: `ingress_certificates.reissue_requested_at` (a reissue must
   survive a control-plane restart after the ingress is already gone) and
   `nodes.certificate_fingerprint` (the heartbeat comparison the preflight reads).
2. **Control-plane issuer, not the Caddy holder.** This follows S4's O1 and the plan's own W7 text;
   `docs/CLUSTERING.md` §7.3 is amended accordingly.
3. **Hot-swap distribution.** `get_certificate http` instead of `certificates.load_files` +
   `POST /load`, because S4 measured the latter dropping 1,000/1,000 keep-alive connections.
4. **Per-host issuance.** The 0122 schema keys a certificate by host, so the sweep issues one order
   per host; S4's lego can put apex + wildcard in one order, which is a follow-up (the pair would be
   stored once per host).
5. **BYO "reference a sealed one"** is not implemented; upload only. Reference semantics need a
   secret-store pointer the brief did not define.
6. **Operator surface is REST only.** CLI, MCP read tools and a dashboard page are not added; the
   CLUSTERING §14 rule is only partly met by this lane.
7. **`renewDue()` acts for the lease holder** while running on the control plane (S4's issuer
   location). The lease is the mutual exclusion and the relay target; with a future standby, only
   the active control plane may run the maintenance sweep (W9).
8. **Relay changes need a desired-state change** to reach Caddy (a config reload), so they land on
   the next pull or within 6 h. Certificate renewals themselves need no reload.
9. **`apps/agent/src/caddy-config.ts`** was edited (manager policy + relay routes). It is not in the
   do-not-touch list, but lane C also touches this file; expect a small conflict. `compile.ts`, the
   ingress payload/route tables and the steering drivers were not touched.

## Lab follow-up

1. Two ingresses with `INGRESS_SET` + `SHARED_CERTIFICATES` on and a Pebble/challtestsrv CA; confirm
   one issuance per host, every node's heartbeat fingerprint equal, and the preflight view agrees.
2. Hold 1,000 keep-alive connections through a renewal triggered by `POST
   /cluster/certificates/:host/reissue`; assert ≤ 1 failed connection and no config reload in the
   Caddy log.
3. Remove one ingress role; assert the sweep reissues and both remaining nodes serve the new
   fingerprint. Then check the removed node's `/var/lib/yoal/certificates` is gone.
4. With the flag off on the same fleet, assert the desired state and Caddy config are byte-identical
   to `ha/integration` and each node still issues per node.
