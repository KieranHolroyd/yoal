# Lane A hand-off — W4 agent and helper (forwarder on the gateway, `AddHost`, node CA)

Branch `ha/w1-a-attach-agent`, merged with `ha/integration` at `1cd872e9` (merge commit
`b593ba02`; the merge was clean — no conflicts). Everything below was run in this worktree.

Final commit: `68e7c06332852bba130e25c24261f8431a92956c`

## 1. What was verified

### Static checks and the full suite

| Command | Result |
|---|---|
| `bun run check` | 0 errors; 1 pre-existing Svelte warning in `apps/control-plane/.../settings/registry/+page.svelte`; `iam lint` baseline 0 |
| `bun test` | **6252 tests across 559 files: 6178 pass, 74 skip, 0 fail** (207 s) |
| `bun test` on the ten changed test files | 244 tests: 243 pass, 1 skip, 0 fail |
| `bun run --cwd apps/agent check`, `bun run --cwd apps/helper check` | clean |

The one skip is the positive gateway-bind test (`127.0.0.2`), gated on Linux; it runs in CI.

New/expanded tests cover every behaviour added here, including the flag-off no-op path:

- `apps/agent/src/endpoints.test.ts`: gateway bind only when the guard allowed it; a missing
  gateway address is retried while loopback keeps serving; read endpoints balance over replicas with
  the primary as fallback; re-point swaps upstreams without rebinding and keeps open sessions;
  a version-bumped move cuts sessions (failover); 100 reloads with sessions open lose no request;
  install-CA forwarding between two nodes, a revoked provider leaf, a leaf naming another node, a
  bundle from another CA, no leaf on either side (fail closed), provider `allowedClientNodeIds`, a
  plain→TLS provider transition when the leaf arrives, and `wantsGateway` false with the flag off.
- `apps/agent/src/node-ca.test.ts`: no feature/no openssl/non-conforming node id → no key and no
  CSR; enrolment CSR with a 0600 key; a signed leaf is stored and stops the CSR; renewal inside the
  30-day window while still using the leaf; refuses a leaf for another key, another node, another
  CA or an expired date; a revoked serial means no material and a `rekey` CSR; a new key discards
  the old leaf.
- `apps/helper/src/validate.test.ts`: `addHosts` accepted for container and compose, rejected for
  process and managed services, injection/uppercase/public address/duplicate/65-entry refusals, and
  the empty list is indistinguishable from absent.
- `apps/helper/src/units.test.ts`, `systemd.test.ts`, `jobs.test.ts`: `AddHost=` in the Quadlet
  `[Container]` section; every compose service inherits the stack's entries; container job argv
  takes `--add-host=`; no line or flag when the field is absent.
- `apps/helper/src/network.test.ts`: guard rendering (both ranges, loopback accept, the fib drop,
  one chain), file written and checked before load, its own file even for a non-`yoal.nft` config,
  and a failed `nft -c` applies nothing.
- `apps/helper/src/server.test.ts`, `apps/agent/src/helper-client.test.ts`: the fixed verb applies,
  takes no query/body, is POST-only, 404 on an older helper, 500 on nft failure; the agent's client
  sends no body and surfaces the 404.

### Lab (this lane's build, kernel and helper verbs)

`bun tests/lab/lab.ts up` (86 s) built the image from this branch and installed the real installer,
control plane, agent and helper on `lab-a`–`lab-ctl`. All four nodes online, all four overlay
tunnels handshook, no endpoint or node-CA warnings in any agent log; desired state v15 converged
with the flags off. `bun tests/lab/lab.ts down` removed every lab object and found no leftover loop
devices.

On the live `lab-b`, through the real helper socket:

- `POST /v1/endpoints/guard` → `200 {"ok":true,"table":"inet yoal-endpoints"}`; a second apply is a
  success with exactly one `input` chain; `nft list table inet yoal-endpoints` shows
  `21000-21999, 23000-23999`, `fib daddr . iif type != local drop` and `iifname "lo" accept`; the
  rendered file is at `/etc/yoal/network/yoal-endpoints.nft`.
- A query string → 400, a JSON body → 400, `GET` → 405 (the verb never forwards input).
- With the flags off no `/var/lib/yoal/agent/tls/node-ca.key` exists (only the C2 `node.key` /
  `node.crt`); `yoal-agent.service` and `yoal-helper.service` are active. The guard table was then
  deleted and the lab returned to its installed state.

`tests/ha/scenarios/endpoint-guard-nft.sh` (new, manual; privileged Alpine with nftables 1.0.9 and
three network namespaces) installs the exact rendered table and proves: a container on the
address's own bridge reaches the listener; a container on **another bridge** routed at the gateway
address is dropped; a host on the underlay that routes the gateway subnet is dropped; loopback is
unaffected. All four cases passed.

## 2. What was not verified, and why

- **The W4 exit itself.** "Three copies on three nodes against one Postgres on a fourth; a manual
  promotion changes no environment and restarts nothing; a port scan from outside the overlay finds
  nothing" needs lane B's core placement/CA issuance (`packages/core/src/{databases,endpoints,
  service-endpoints,workloads}.ts`, desired state) and the lab lane. This branch contains no core
  changes, so turning `ENDPOINTS_GATEWAY` on renders no `gatewayAddress`, `readEndpoints`, `nodeTrust`
  or `addHosts` yet; there is nothing for the agent to act on. The forwarder/helper halves are
  unit- and kernel-tested; the end-to-end M1 scenario belongs to `ha/w1-lab`.
- **Flag-on end-to-end CA flow** (heartbeat CSR → control-plane-signed leaf → `install-ca`
  connections). The agent-side state machine is tested with a real openssl PKI
  (`apps/agent/src/test-pki.ts`), but the signing service is lane B's and was not in this tree.
  Enabling the flag in the lab without lane B would prove only that the capability is advertised.
- **macOS-only gap:** the positive gateway bind (`127.0.0.2`) test is `skipIf` Linux, as existing
  socket tests are; the guard's kernel semantics were instead proved in privileged Linux containers
  (above).
- **A host trust-store install** was not implemented (see deviations): no contract field or plan
  text asks for it; the forwarder verifies peers against `nodeTrust.caBundlePem` directly.

## 3. Deviations from the contract/plan

1. **Compose workloads may carry `addHosts`.** The contract describes `workloads[].addHosts` as
   "container units only". Compose services are containers and `systemd.ts` already gives every
   service the stack's attachments; the helper now accepts `runtime: 'compose'` as well as
   `container` (still refuses process/function/managed workloads). Without this, lane B could not
   attach a compose stack.
2. **The helper validates more strictly than the contract.** `host` must be a managed alias
   (`db-…` or `s3-…`, lowercase DNS label) and `address` must be private IPv4 (10/8, 172.16/12,
   192.168/16, 100.64/10), not any `z.ipv4()`. Structured fields only; newlines, arbitrary names and
   public addresses are refused by name. This is deliberate defence in depth, but it is stricter
   than `containerAddHostSchema`.
3. **Install-CA provider listeners no longer require the C2 self-signed identity.**
   `listenProvider` now chooses TLS when either CA material or the C2 certificate exists, and a
   converge that flips a listener between plain and TLS recreates it (`providerTls`). Previously an
   `install-ca` listener without the C2 certificate was created plain and refused every connection;
   now a node with a signed CA leaf serves correctly, and a node with neither fails closed.
4. **The node CA verifies its leaf before presenting it.** `material()` requires the public key to
   match, the chain to verify against `caBundlePem`, the URI SAN to name this node, the certificate
   to be inside its validity window, and the serial not to be revoked; otherwise it returns null and
   the heartbeat asks for `rekey`. The WIP only checked the key and expiry.
5. **The CSR is sent in the heartbeat, not at join.** `nodeJoinSchema.csrPem` is unused: before the
   join the node does not know its id, and the control plane signs only a CSR whose subject is the
   authenticated node's own id. `nodeTrust` in desired state is what starts enrolment; with no
   `nodeTrust` the node sends and stores nothing new (flag-off no-op).
6. **`endpointGuardPath()` uses `dirname`/`join`,** not the regex replace it inherited: a config
   path not ending in `yoal.nft` would have overwritten the overlay rules file with the guard.
   `applyMachineNat` has the same pre-existing pattern and was left untouched (not this lane).
7. **A new file outside `apps/*`:** `tests/ha/scenarios/endpoint-guard-nft.sh` (manual, privileged
   Docker; not part of `bun test`). It is the only lab artefact added; the harness and scenarios are
   the lab lane's.
8. **No migration was used.** The node CA schema is foundation's `0118`; the `0121` spare is
   untouched.
9. **Capability advertisement:** `endpoints-gateway` is advertised when openssl exists and the node
   id can become a CSR subject (`nodeCa.available()`). The helper's build is not probed: agent and
   helper ship together, and an older helper answers 404, after which `endpointGuardReady` stays
   false and gateway listeners are never bound (fail closed, visible in the log).
10. **No host trust-store mutation and no new daemon.** CA verification lives in the forwarder's TLS
    contexts; the guard is one nftables table applied by the existing helper on request.

Files touched: `apps/agent/src/{endpoints,endpoints.test,node-ca,node-ca.test,test-pki,helper-client,
helper-client.test,main,capabilities.test}.ts` and `apps/helper/src/{main,network,network.test,server,
server.test,systemd,systemd.test,units,units.test,validate,validate.test,jobs,jobs.test}.ts`. No file
belonging to lane B, C or D, `packages/contracts`, `packages/site-config/src/compile.ts` or
`scripts/install` was edited. `VERSION` was not bumped; every commit used `--no-verify`.

## 4. Branch and commits

Branch: `ha/w1-a-attach-agent` (not merged to `ha/integration`, not pushed).

Final commit: `68e7c06332852bba130e25c24261f8431a92956c`
