# Lane B hand-off — W4 core and placement

Branch `ha/w1-b-attach-core`, based on `ha/integration` `1cd872e9`.

## What this lane ships

- `packages/db/migrations/0121_service_endpoint_roles.sql` (renumbered from 0122 by the
  integrator: lane A did not use 0121): `service_endpoints.role` (`primary`/`pool`/`read`) and
  `version`; the unique key becomes (consumer node, kind, service, role). Additive only.
- `packages/core/src/{databases,endpoints,service-endpoints,node-ca,workloads,nodes}.ts`:
  - containers may place copies off the database's node when `ENDPOINTS_GATEWAY` is on and the
    node declares `endpoints-gateway` (G9);
  - every attachment gets a stable consumer endpoint on every node that runs a copy, including
    the consumer's own node, so a promotion re-points the upstream and leaves host, port and
    activation unchanged (G10);
  - pooled (`_POOL_URL`) and read endpoints across nodes (G11);
  - core-side node CA issuance (`node-pki.ts`, `node-ca.ts`) and desired-state distribution.
- `packages/contracts/src/endpoint.ts`: the endpoint shape with roles/version.
- Tests: `attach-gateway.test.ts` covers the three-copies/three-nodes/one-Postgres exit, the
  same-node reuse, promotion stability, a moved read replica, the gateway-only bind (no public
  bind) and the single-node gate. `node-ca.test.ts` covers one unrevoked leaf and key.

## Verified

- `bun run check`: 0 errors.
- `bun test`: 6152 pass, 73 skip, 0 fail.
- Flag-off single-node gate: `attach-gateway.test.ts` asserts a container stays on its
  database's node and gets no gateway fields.
- Migration stream: `scripts/check-migrations.test.ts` passes (0121 now contiguous).

## Not verified

- The four-node lab run (`attachments-three-nodes`) is lane lab's and needs real containers; the
  unit/integration tests assert the desired state, not a live port scan.
- Lane A's helper verbs are not exercised end to end here.

## Deviations

- Migration renumbered 0122 → 0121 (integrator; A's spare was unused). No other out-of-lane files.
