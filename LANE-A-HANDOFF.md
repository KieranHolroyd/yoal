# Lane A hand-off — W4 agent and helper

Branch `ha/w1-a-attach-agent`, based on `ha/integration` `1cd872e9`.

## What this lane ships

- `apps/helper/src/validate.ts` + `network.ts` + `server.ts`: fixed-verb helper surface for
  `AddHost` and gateway-address binds. No shell strings cross the control-plane boundary; a verb
  and structured arguments are validated against a closed list.
- `apps/helper/src/units.ts`: unit rendering for the new verbs (host alias, forwarder bind).
- `apps/agent/src/endpoints.ts`: forwarder binds on `127.0.0.1` as today, and on the node's
  container gateway address only when the node advertises `endpoints-gateway` (F7/H24); the
  endpoint guard still refuses a port the agent does not own.
- `apps/agent/src/node-ca.ts` + `test-pki.ts`: node CA identity (one unrevoked leaf per node and
  public key) and the test-only PKI used by the lab.
- `apps/agent/src/main.ts`, `helper-client.ts`, `capabilities.test.ts`: capability reporting and
  helper calls.

## Verified

- `bun run check`: 0 errors.
- `bun test`: 6177 pass, 74 skip, 0 fail (new tests: `endpoints.test.ts` +358 lines,
  `node-ca.test.ts` 141 lines, helper `validate.test.ts`/`units.test.ts`/`jobs.test.ts`).
- Flag/capability off: without `endpoints-gateway` the forwarder description is byte-identical to
  today (tests assert the same socket rows).

## Not verified

- The W4 lab exit (three copies on three nodes against one Postgres on a fourth; promotion changes
  no environment and restarts nothing; external port scan is empty) needs lane B's core placement
  and the lab lane. A did not run the lab.
- CA distribution end-to-end through activation (lane B owns the desired-state side).

## Deviations

- None outside the lane's files. No migration (node CA is `0118`, foundation).
- `apps/agent/src/test-pki.ts` is test-only and imported only by tests.

## Note

The helper verbs are deliberately narrow: `AddHost` adds one host alias, the gateway verbs bind
one address; everything else is refused by the closed validation table.
