# Lane B hand-off — W4 core and placement

Branch `ha/w1-b-attach-core`, based on `ha/integration` `1cd872e9`.

## What this lane ships

- **G9 removed for containers behind `ENDPOINTS_GATEWAY`.** A container app with a database
  attachment may place copies off the database's node when the flag is on and the target node's
  agent advertises `endpoints-gateway`. Nodes without the capability keep today's same-node
  placement (a refusal is avoided rather than handing an agent fields it would ignore).
- **One stable endpoint per attachment, on every node that runs a copy.** With the flag on, the
  same-node attachment also goes through an endpoint (upstream `127.0.0.1` on the consumer),
  `serviceEndpoints[].gatewayAddress` is the container gateway, and workload desired state carries
  `addHosts: [{ host: db-<id>, address: 10.89.0.1 }]` for container apps. Host, port and activation
  version do not change when the database moves (G10).
- **`_POOL_URL` across nodes (G11).** A database's pooler gets its own `pool` endpoint; local port
  and upstream are separate from the primary endpoint.
- **Read endpoints.** `readEndpoints` (23000–23999) follow readable replicas with the primary as
  the last fallback, and `_READ_URL`/`_READ_URLS`/`_READ_HOST`/`_READ_PORT` use one stable port.
  Once created, a read endpoint keeps its port when every replica stops or a promotion moves the
  primary; only its presence (never the replica set) is folded into the consumer version.
- **Core-side CA.** `node-pki.ts` builds/parses the X.509 and PKCS#10 shapes; `node-ca.ts` creates
  the install CA (key sealed with the master key), signs node CSRs, renders `nodeTrust` (CA bundle,
  leaf, revoked serials) and revokes leaves. `nodes.heartbeat` signs a CSR only from a node that
  advertises `endpoints-gateway` while the flag is on.
- **Mixed versions / single-node gate.** Desired state keeps using the foundation's
  `gateDesiredState`; with the flag off, or on a node without the capability, no `readEndpoints`,
  `nodeTrust`, role/gateway/trust/version fields or `addHosts` are rendered, and placement/env are
  today's. `desired-state/golden.test.ts` remains byte-identical.
- **Migration.** `0121_service_endpoint_roles.sql`: adds `service_endpoints.role`
  (`primary`/`pool`/`read`) and `version`, and widens the unique key to
  (consumer, kind, service, role). Existing rows backfill as `primary`/version 0.

## Verified

- `bun run check` — all workspaces, 0 errors (one pre-existing svelte warning outside this lane).
- `bun test` — full suite: **6152 passed, 0 failed** (73 skipped). One earlier run had an unrelated
  timing failure in `apps/helper/src/faults.test.ts`; it passed in isolation and in the final run.
- `bun test tests/ha` — 66 passed, 0 failed.
- `node_modules/.bin/tsc -p tests/ha` — clean.
- New tests: `packages/core/src/attach-gateway.test.ts`,
  `packages/core/src/node-ca.test.ts`, plus planner/role cases in `packages/core/src/endpoints.test.ts`
  and the `0121` backfill case in `packages/db/src/migrations.test.ts`. They cover:
  three container copies on three nodes against one Postgres on a fourth; same-node endpoint reuse;
  promotion leaving env/port/activation unchanged; a read endpoint surviving losing its replica;
  pooled URL in both process/container shape; overlay-only listeners (no public bind) in desired
  state; flag-off single-node gate; CA chain/SAN, re-send, re-key revocation and refusals.
- Migration stream: `packages/db/scripts/generate-migrations.ts` re-ran (121 embedded) and
  `scripts/check-migrations.test.ts` passes.

## Not verified

- The authoritative four-node lab run (`attachments-three-nodes`, real Podman containers, a real
  external port scan) is lane lab's later job. The tests above assert the desired state and the
  env/placement logic, not a live container reaching the forwarder.
- Lane A's helper/agent side (forwarder on the gateway address, `AddHost` emission, CA trust on
  nodes) is not exercised end to end here.
- CA renewal/rotation operator surface and a rotation (`previous` CA) test: rotation is supported
  by the schema/bundle but no command rotates the CA in this lane.
- `_READ_POOL_URL` is not offered: C7 replicas have no pooler today, so there is no read replica
  pooler endpoint to point it at. The contract field remains unused.
- Cross-node private storage for containers is unchanged; this lane only removed the gate for
  database attachments (storage is not in the owned file list).

## Deviations

- **Migration number: used `0121`, not reserved `0122`.** `scripts/check-migrations.test.ts`
  requires a contiguous stream and lane A's `0121` is not in this worktree/branch; `0122` alone
  fails the suite. The integrator should renumber this file to `0122` when lane A's migration
  lands (or keep whichever is contiguous in the merged tree). Content and intent are unchanged.
- Edited `packages/contracts/src/endpoint.ts` only to add `CONTAINER_GATEWAY_ADDRESS`, a constant
  the core and lane A can share. No other contracts semantics changed.
- Edited `docs/OPS.md` (the feature-flag row no longer says "not built") and the read-URL bullet in
  `docs/DATABASES.md`. No other docs changed.
- `packages/db/src/migrations.test.ts` and `packages/core/src/endpoints.test.ts` were updated for
  the new migration/planner key; `ha-wave1-foundation.test.ts` lost its CA-stub assertion because
  the CA is implemented.
- No VERSION bump.

## Final commits

`407d0fcb` (read-endpoint stability + docs) on top of `c5e1b4e8`/`81009dc0`. The branch head after
the hand-off file is committed is the final SHA reported in the lane message.
