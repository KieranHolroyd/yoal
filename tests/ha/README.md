# tests/ha — the HA checker and the lease simulator

HA-PLAN §4 W1 (bullets 3–4) and the M1 acceptance scenarios. Three tools:

| Path | What it is |
|---|---|
| `scenarios/` | The **scenarios**: each deploys the checker app on the lab (tests/lab), applies a fault or a change under the checker, and writes numbers plus a verdict. See [Scenarios](#scenarios). |
| `checker/` | The **checker**: a client that writes numbered rows and reads them back through the public route, plus invariants I1–I7 (CLUSTERING §19.1) and I11–I16 (HA-PLAN §1.3) as pure functions over its request log and the lab's observations. |
| `checker/app/` | The **checker app** it talks to, deployable on Yoal as a process or container app with a Postgres database attached. |
| `sim/` | The **deterministic simulator** for `ControlLease` (`packages/core/src/ha-lease.ts`). |

`bun test tests/ha` runs all unit tests in about 3–4 s. tests/ha is not a workspace package; type-check
it with `node_modules/.bin/tsc -p tests/ha` (not part of `bun run check`). zod comes from
`packages/contracts`' install through `checker/zod.ts`.

## The checker

```sh
bun tests/ha/checker/cli.ts --url http://<ingress> [--host <Host header>] --duration-s 300 --rate 20 \
  --seed 7 [--observe obs.jsonl] --out report.json [--log requests.json] \
  [--timeout-ms 5000] [--rpo-ms 0] [--db-lease-ttl-ms 30000] [--lease-ttl-ms 30000]
```

Open-loop at `--rate` requests per second, for the whole run: two `POST /w` (new row n) then one
`GET /r` (the newest acknowledged row, or one time in four an older one). After the run it reads every
acknowledged row back (retrying for up to 30 s while the answer is neither 200 nor 404), fetches
`GET /singletons`, reads `--observe`, and writes the report. Exit 0: no invariant failed; 1: one did;
2: usage or I/O error.

The report (`checker/report.ts` exports the type and the zod schema): `seed, startedAt, endedAt,
requests, failedRequests, failedByStatus, longestWriteGapMs, acknowledgedWrites,
lostAcknowledgedWrites, duplicateSingletonRuns, invariants{I1…I7, I11…I16: {status, evidence}}`.

- `requests`/`failedRequests` count the run's writes and reads, not the final verification. A request
  fails when it does not answer 200; `failedByStatus` keys are the status, or `network` / `timeout`.
- `longestWriteGapMs`: the longest interval with no acknowledged write, from run start to run end.
- `lostAcknowledgedWrites`: acknowledged rows the final verification did not read back intact: 404,
  different content, or still failing (or never read) when the 30 s retry budget ran out. These are
  the rows I6 fails, less any it forgives inside `--rpo-ms`.
- `duplicateSingletonRuns`: extra starts per (job, run), with the app's records and the `singleton`
  observations merged: each observed start is matched to a distinct app record of the same copy
  (the observation's `copy`), else the same node, else one that names neither, and only an unmatched
  one adds a start. So per copy the larger view counts, and different copies add up. A lab names
  copies and nodes as the app does (`x-checker-copy`; `CHECKER_NODE` / `YOAL_NODE_ID`). App records
  from before the run (more than 60 s before it started) are ignored, since the table outlives one run.

### The app

`bun tests/ha/checker/app/server.ts` (or `docker build tests/ha/checker/app`). Env: `PORT` (8080),
`DATABASE_URL`, or `CHECKER_STORE=memory` for tests; `CHECKER_NODE` / `CHECKER_COPY` name it (fallback:
`YOAL_NODE_ID` or the hostname, and `<hostname>:<port>:<pid>`; Yoal injects no copy id into a
workload today). Every response carries `x-checker-node` and `x-checker-copy`.

| Route | |
|---|---|
| `POST /w?n=<int>&writer=<id>[&v=<payload>]` | Insert row (writer, n) in one transaction; 200 only after commit. Idempotent for the same payload, 409 for another. |
| `GET /r?n=<int>[&writer=<id>]` | The row as JSON, or 404 |
| `GET /healthz[?db=1]` | 200 while the process runs; with `db=1` also `SELECT 1` (503 on failure) |
| `GET /singleton?job=<id>&run=<id>` | Record a singleton run start; answers the count so far. Use job `release:<release id>` from a release command (I16) |
| `GET /singletons[?job=<id>]` | Every recorded start (additive to the contract) |
| `GET /whoami` | `{ node, copy, pid }` |

A singleton job reports itself with something like
`curl -fsS "$CHECKER_URL/singleton?job=nightly&run=$(date -u +%Y%m%dT%H%M)"`, so two copies of one
scheduled occurrence share a run id.

### Observations

`--observe` is a JSON-lines file the lab appends to during the run: `{ t, kind, node, ...fields }`,
`t` in epoch ms on the checker host's clock (or NTP-synced to it). A torn last line is ignored; other
bad lines are reported on stderr and skipped. Unknown fields are kept. An invariant with no relevant
observation is `not-observed`, never `pass`.

**Sample lifetime.** A `lease {holds:true}` (I1) or an accepting `db-role {role:'primary'}` (I3) is
evidence for one lease TTL (the observation's `ttlMs`, else `--lease-ttl-ms` / `--db-lease-ttl-ms`,
30 s), so the lab re-reports a held state at least once per TTL (every lease tick does). A later
`holds:false` / non-primary role, or `fault {fault:'crash'|'kill'|'stop'|'power-off'|'reboot'|'node-down',
state:'start'}` on that node, ends it sooner. A holder that crashed is not a holder forever.

| Inv. | Reads | Fails when |
|---|---|---|
| I1 | `lease {epoch, holds, ttlMs?}` from each control node (scope `control`, the default); `write-attempt {target:'control', epoch, accepted}` | two nodes `holds:true` at once (each sample current, see above); control writes accepted by two nodes in one epoch. Only `holds:false` samples: `not-observed` |
| I2 | `epoch {epoch, source?}`; node `lease {epoch}`; `lease` from node `arbiter` `{epoch, holder}` | a node's epoch (per source) goes down; the arbiter's epoch goes down, changes holder without +1, or names two holders |
| I3 | `db-role {database, generation, role, acceptingWrites?, ttlMs?}` | two primaries in one generation; two nodes primary and accepting writes at once (each sample current) |
| I4 | the app's `/singletons`; `singleton {job, run, event?:'start', copy?}` | a (job, run) started twice, the two sources merged per copy |
| I5 | `mount {volume, mode:'rw'\|'ro'\|'none'}` (kind added to the contract); `write-attempt {target:'volume', volume, accepted}` | a volume rw on two nodes; a write from a node without the rw mount |
| I6 | the checker's own log; `db-role {role:'primary', promotion}` for `--rpo-ms` | an acknowledged row is gone, differs, or cannot be verified (losses within `--rpo-ms` before a promotion are noted, not failed) |
| I7 | `fence {component?, fenced}`; `write-attempt {target, accepted}` | a fenced node accepts a write for the fenced component. Observed only once a write is attempted on a fenced node |
| I11 | `fault {fault:'control-down' or target:'control', state:'start'\|'end', id?}`; the checker's log | a request inside a control-down window fails while no other fault is open |
| I12 | `lease` from `arbiter` `{scope:'database', database, syncSet}`; `db-role {role:'primary', promotion:'auto'}` | an automatic promotion outside the latest recorded synchronous set, or with none recorded |
| I13 | member `lease {scope:'database', database, holds, ttlMs?}` (each confirmed renewal); `write-attempt {target:'database', accepted}` or `db-role {role:'primary', acceptingWrites:true}` | for a database with any member lease reported: a node accepts its writes more than one TTL after its last `holds:true`, or without ever holding it (a rogue writer, member or not) |
| I14 | `ingress {ready?, inRotation?}` (ready = can serve: routes converged, releases present, certificates loaded; a lame-duck ingress is still ready); `route {converged}` without `copy` | an ingress in rotation while not ready, never reported ready (once the lab reports readiness for any ingress), or not converged |
| I15 | `route {copy, event:'added'\|'started'\|'removed'\|'stopped'}`; the `x-checker-copy` of each response | a copy stopped while still in the upstreams; a request that started after the copy left the upstreams reached it |
| I16 | `release-command {release, event:'start'\|'end'\|'rollout-start', ok?, copy?}`; app singletons with job `release:<id>` | a release command started twice (sources merged per copy, as I4); a rollout started before a successful end |

**Not observable from outside today.** Yoal has no control epoch (the lease is unused), no database
member lease, no synchronous set, no ingress readiness, no release phase and no volume mount
registry the lab can read. Until those exist, I1, I2, I3 (no generation per role), I5, I7, I12–I16
can only be fed by a lab that synthesises the observation (for example a `write-attempt` probe
against a node it fenced), and are `not-observed` on a plain run. I4 and I6 work today from the
checker and the app alone; I11 works as soon as the lab records a control-down window.

### Locally against Postgres

```sh
docker run -d --name yoal-w0-checker-pg -e POSTGRES_PASSWORD=w0lab -e POSTGRES_DB=checker \
  -p 127.0.0.1:46731:5432 postgres:18-alpine
PORT=46732 HOST=127.0.0.1 DATABASE_URL=postgres://postgres:w0lab@127.0.0.1:46731/checker \
  bun tests/ha/checker/app/server.ts &
bun tests/ha/checker/cli.ts --url http://127.0.0.1:46732 --duration-s 30 --rate 50 --seed 11 --out /tmp/report.json
```

## Scenarios

Each scenario runs against a lab brought up with `bun tests/lab/lab.ts up` (the single-node gate:
`up --only lab-a`), and writes into `tests/lab/.out/<scenario>-<time>/` (or `--out`):
`scenario.json` (verdict, checks, timings, measures, timeline), `summary.md` (the same, readable),
`report.json` (the checker's), `observations.jsonl` (what the scenario told the checker), and the
checker's logs.

| Scenario | For | What it does | Today on `ha/integration` |
|---|---|---|---|
| `single-node-gate.ts` | Every lane (§7.3) | One node, every opt-in flag off (every flag whose registry default is false): deploy, scale 1→2→1, redeploy, under the checker | **pass** |
| `kill-node.ts` | M1, §1.2 node loss | Two copies (keeper + `--node`); power off (`--method kill`), stop, or partition the node; time offline (≤ 40 s), re-placement, answering (≤ grace + 120 s), rejoin | **pass** direct, **fail** edge |
| `kill-node-b.ts` | W1 exit | `kill-node.ts --node lab-b` | as kill-node |
| `freeze-agent.ts` | §7.2 Process | `SIGSTOP` the agent on a copy's node for 60 s; the copy must keep serving with its database, nothing restarts or moves | **fail** |
| `attachments-three-nodes.ts` | W4 exit, M1 | Container app, three copies on lab-a/b/c, Postgres on lab-ctl; manual promotion must change no env and restart nothing (two after-snapshots: 20 s after it, and after the checker); a positive control, then a port scan of the endpoint, read, database and pooler ranges from the lab bridge. Needs `ENDPOINTS_GATEWAY`; `--skip-promotion` leaves the promotion out | **skip** (container, flag off); `--runtime process` **fail** |
| `rolling-deploy-under-load.ts` | W5 exit, M1 | 10,000 requests a minute through a rolling deploy; a failing release command; a release command under a partition of the node the platform leased it to (I16). C and D need `RELEASE_PHASE` | B **fail** (3 non-2xx); C, D **skip** (flag off) |

**Feature flags.** A scenario that needs an opt-in flag reads the platform's resolved flags (`GET
/api/setup/status` → `features`) and is `skip` only when the flag is off, naming the command that
turns it on. With the flag on, a refusal is a `fail`. Bring the lab up with the flags the scenario
needs:

```sh
bun tests/lab/lab.ts up --feature ENDPOINTS_GATEWAY=1 --feature RELEASE_PHASE=1
bun tests/ha/scenarios/attachments-three-nodes.ts                 # container, judged
bun tests/ha/scenarios/attachments-three-nodes.ts --skip-promotion   # placement, traffic and the scan only
bun tests/ha/scenarios/rolling-deploy-under-load.ts               # A–D, judged
```

| Scenario | Needs | Without it |
|---|---|---|
| `attachments-three-nodes --runtime container` | `SERVICE_ENDPOINTS` (default on), `ENDPOINTS_GATEWAY` | `spread` skip; the port scan still runs |
| `attachments-three-nodes --runtime process` | `SERVICE_ENDPOINTS` | as above |
| `rolling-deploy-under-load` C and D | `RELEASE_PHASE` | C and D skip; A judges nothing; B runs |
| `single-node-gate` | every opt-in flag **off** | `invalid` |

### Verdicts

Every scenario ends with one verdict (`scenarios/lib/report.ts`), and every check inside it has one:

| Verdict | Exit | Means |
|---|---|---|
| `pass` | 0 | every judged bound and invariant held |
| `fail` | 1 | one did not; the reason names it, with the number and, for a known bug, `path:line` |
| `invalid` | 2 | the run cannot measure what it is for, because of how the platform is today (a copy the edge never sends traffic to); its numbers would mislead |
| `skip` | 3 | it needs a feature another lane is building; the reason quotes the platform's refusal or the missing field |
| `error` | 4 | the harness could not run (lab down, a deploy timed out); never a statement about the platform |

The overall verdict is the worst check (`error` > `fail` > `invalid` > `skip` > `pass`), or an early
stop's. `--accept invalid,skip` maps those verdicts to exit 0 for a CI step that is known to be
invalid or skipped on this tree (each such step in `.github/workflows/ha.yml` says why).

**Targets.** `--target edge` (default) sends the checker through lab-a's public route, as a user.
`--target direct` bypasses the edge: the scenario's own balancer sends each request straight to a
copy (relayed through lab-a). A direct run judges re-placement, restarts, the checker's invariants
and failed requests: zero, as on the edge, except in `kill-node`, where failures inside the fault
window are allowed (the balancer marks the lost copy down only after it failed a request: the fault
to 10 s after it, or the whole partition) and any outside it fails. The reason says the failures
went through the harness balancer, and the report says "Edge bypassed" at the top.

**The checker check.** Every scenario fails `checker` when an invariant failed **or I6 did not
pass** (`not-observed` means no write survived to judge, so the run is not evidence);
`attachments-three-nodes` also needs one acknowledged write. All judging is in
`scenarios/lib/judge.ts`, unit-tested in `judge.test.ts`; `Scenario.finish`'s overall verdict is
`decideVerdict` in `report.ts`, tested in `report.test.ts` and end to end in `scenario.test.ts`. On a tree without F7
(`ha/w1-fixes`), every edge run with a remote copy is `invalid`: the edge's active health check
sends no app Host (`packages/site-config/src/compile.ts`), so remote copies take no traffic.

### The library (`scenarios/lib/`)

| Module | Gives |
|---|---|
| `scenario.ts` | `Scenario`: output directory, observation log, timeline, `check()`, `stop()`, cleanups that run on any exit (Ctrl-C too), the report written last; `waitFor`, `COMMON_OPTIONS` |
| `judge.ts` | every verdict as a pure function: the checker check, failed requests, feature gates, the release-phase decision, unit and env comparisons, listener parsing, the I16 judgement over the platform's release-command runs |
| `app.ts` | `deployChecker()` (project, Postgres on a chosen node, process or container workload, N copies placed on named nodes by drain/resume), `placeCopies`, `copies`, `scaling`, `unitInfo` (a copy's unit invocation, start time and env-file hash, never the values; nothing read is `null`, never the hash of empty input), `settledUnits` (two reads that agree), `nodeListeners`/`connectsFrom` (the port scan's positive control), `releaseRuns` (the platform's release-command runs, read-only from lab-a's database: no REST route lists them yet), `loadCheckerImage` (the checker app's image into every node's Podman as `localhost/…`), `appPort` (one port per project in 24000–24999) |
| `ingress.ts` | `openTarget(edge\|direct)`, `share` (who answers), the direct `CopyBalancer` |
| `faults.ts` | `Faults.apply(power-off\|stop\|partition\|freeze)` with revert, timeline entries and `fault` observations; everything reverted on exit unless `keep()` |
| `checker.ts` | `startChecker()`: the checker CLI against a target, reading the scenario's observations |
| `portscan.ts` | `scanFromBridge()`: a TCP connect scan from a throwaway container on the lab bridge (not the overlay) |
| `report.ts` | verdicts, exit codes, `scenario.json` and `summary.md` |

`fixtures/release-command.ts` is the release command the W5 scenario ships into each release (it
records `release:<marker>` through the app's `/singleton`, and can fail or sleep on purpose).

### What the scenarios found on `ha/integration` (2026-11-20)

On `ha/w1-lab` = `ha/integration` + `ha/w1-fixes` (F7–F12), container lab on OrbStack (arm64).
Every run's `scenario.json` has the full numbers.

| Scenario | Verdict | Numbers | Why |
|---|---|---|---|
| `single-node-gate` | **pass** | 3,001 requests: 0 failed outside the redeploy, 2×503 during the single copy's in-place restart; 0 lost writes; scale to 2 refused (422), first copy untouched; redeploy running in 10 s | — |
| `kill-node --node lab-b --target direct` | **pass** | offline 33 s; re-placed on lab-c, answering at 124 s (bound 240 s); 0 lost of 3,200 writes; 9 of 4,801 failed (harness balancer, not judged) | — |
| `kill-node --node lab-b` (edge) | **fail** | offline 29 s; re-placed and `running` at 126–182 s, never in the edge's upstreams; 0–2 of 4,801 failed; 0 lost writes | a copy re-placed by failover reaches the edge only on the next unrelated desired-state change: its move to `running` bumps no version, and the edge's list is built from copies `running` at build time (`packages/core/src/nodes.ts:1249-1268`). Proved by bumping the project by hand: the next version listed it |
| `kill-node --node lab-b --method partition` (edge) | **fail** | offline 28 s; re-placed `running` at 135 s, never in the edge; 2 of 4,801 failed (1×503, 1 timeout) | as above |
| `freeze-agent --node lab-b` (edge) | **fail** | 0 of 17 `/healthz?db=1` probes answered during the 60 s freeze; 6 of 3,601 requests timed out; offline at 30 s, online 0.4 s after the thaw; no restart, no re-placement | the cross-node database endpoint lives in the agent process (`apps/agent/src/endpoints.ts`), so a frozen agent cuts every remote copy on its node off from Postgres. With `/whoami` probes (no database) the direct run passed |
| `attachments-three-nodes` (container) | **skip** | port scan: 8,000 ports on 4 nodes, 0 open | the platform's own refusal: "an HTTP app runs one copy per node, and this one must stay on its node because it runs next to its attached database (D56)" (G9, `crossNodeAllowed()`, `packages/core/src/databases.ts:3636`); W4 |
| `attachments-three-nodes --runtime process` (edge) | **fail** | 3 copies on a/b/c, Postgres on lab-ctl; manual promotion to lab-a completed in 58 s; **all three** copies' env changed and all three restarted (the remote ones too, not only the same-node one); 916 of 4,801 requests failed around it; 0 lost writes; port scan 0 open | G10 (`packages/core/src/databases.ts:2943-2963`), wider than HA-PLAN states: every consumer restarts, not only those on the old or new primary's node |
| `rolling-deploy-under-load` (edge) | **fail** (B), **skip** (C, D) | 10,020 requests a minute; rollout of 3 copies done in 39.5 s; 3 of 30,061 not 2xx (1×503, 2 connection) | G22: no drain (a copy leaves the upstreams in the version that restarts it). C and D: the workload API accepts and drops `release` and `readinessPath` (`RELEASE_PHASE`, W5) |

Not seen: the "protected site health check passes on the login redirect" problem; no scenario uses a
protected route.

**Checker caveat (I15).** Yoal injects no copy id into a workload, so the app's `x-checker-copy`
(`host:port:pid`) never matches the platform's copy id in a `route` observation, and I15's
late-request half cannot match. The scenarios therefore emit no `route stopped` events for
unplanned losses (a crash stops a copy while it is in the upstreams by definition). W5's drain
scenarios need a per-copy id in the workload environment (e.g. `YOAL_COPY_ID`) to judge I15.

## The simulator

```sh
bun tests/ha/sim/run.ts --runs 2000                    # ha-sim CI: the real lease, default profile
bun tests/ha/sim/run.ts --seed 42 --trace              # replay one seed and print its trace
bun tests/ha/sim/run.ts --seed 42 --runs 1 --keep 3,7  # replay a shrunk fault schedule
bun tests/ha/sim/run.ts --module planted --runs 500 --expect-violation
bun tests/ha/sim/run.ts --module mutant:fence-29s --runs 2000 --expect-violation   # see Mutants
bun tests/ha/sim/run.ts --profile adversarial --runs 2000   # outside the lease's assumptions
```

Seeds run from `--seed` (1) to `--seed + --runs − 1`. A failing seed is shrunk (greedy delta debugging
over its fault list) and printed with its replay command and trace. A seed replays exactly: one
seeded PRNG for the schedule, one for clocks, one for runtime draws, and a discrete-event loop that
resumes the lease's `await`s only when it delivers a response. Other flags: `--module real|planted|mutant:<name>|<path>`,
`--contenders n`, `--verbose` (every request), `--no-shrink`, `--max-report`, `--max-lines`, `--show-stalls`.

**World.** 2–4 contenders, each a `ControlLease` from the module under test, with its own monotonic
clock (rate drift) and wall clock (offset, NTP steps); a store with one linearizable object and
conditional PUT (412 on a stale ETag); three store frontends behind one endpoint, each request served
by a random one, whose `Date` clocks sit anywhere within the policy's skew tolerance (±5 s, favouring
the extremes, so two frontends differ by up to 10 s), jittered ±400 ms and truncated to the second; a
network with per-leg delays. Faults: partitions (refused or black-holed), slow links, process freezes
(SIGSTOP), crashes and restarts, store 5xx before or after applying a write, PUT throttling (503 on
PUTs only), lost responses after the store acted, 501 episodes, spurious 409s, node wall-clock steps,
store clock steps (one frontend, or the whole store, to a new offset still within ±5 s),
promotion-gate changes, planned switchovers (`release()`, with writes stopped first) and break-glass
`forcePromote()` (after stopping every node that thinks it is primary). An operator re-seeds fenced
nodes after 20–180 s; at 600 s everything heals; runs are 780 s simulated.

**Targeting.** A node fault (partition, slow, freeze, crash, 5xx, throttle, lost responses, clock
step, stale reads) aims at the node the store names as holder when it starts (half of them), at the
node the fault before it hit, 0–15 s later (a quarter: a partition then a clock step, a slow link then
a freeze), or at a random node. Fault lists print the mode, e.g. `holder(else n1)`.

**Properties**, after every event and at every proof deadline. *Acting* means `holds()` on a live,
unfrozen process that is not mid-release.

| | Property |
|---|---|
| I1 | at most one contender acts at any instant (no fencing margin is granted) |
| I1s | a contender acts only while the store names it, unreleased, at its epoch |
| I2 | the stored epoch never decreases and rises by exactly 1 per new holder; no process sees its epoch go down |
| I13 | a contender acts at most *the I13 bound* after the store *applied* its last renewal, takeover or bootstrap (the I7/I13 fence-window shape) |

The I13 bound comes from the profile and the documented policy (`DOCUMENTED_POLICY` in
`profiles.ts`, never the module's own, so a mutant cannot loosen its judge): `fenceAfterMs / (1 −
drift)` + the longest return leg + the longest freeze + 1 ms, capped at the TTL. Default: 20 002 +
4 000 + 5 000 + 1 = **29.004 s**; adversarial: 30 s (the cap).

Liveness (a primary exists at the end, after the heal) is reported, never failed.

**Profiles.** `default` holds the assumptions the lease's 20 s / 40 s argument needs: a response is
acted on within 10 s of the store applying it (legs ≤ 4 s, freezes ≤ 5 s and never chained), ≤ 100 ppm
drift, store frontends within the skew tolerance (±5 s: the "TTL + twice the skew" in
`takeoverAfterMs`), requests time out (10 s), a linearizable store, and an honest operator.
`adversarial` drops them: legs to 20 s, freezes to 90 s, 1000 ppm drift, frontends up to ±15 s, no
request timeout (as `S3ObjectStore` has none today), stale reads and responses without a `Date`.

**Planted bug.** `sim/fixtures/ha-lease-planted.ts` is ha-lease.ts with one line added: a primary's
GET of its own record counts as a confirmed renewal. With PUTs throttled it keeps passing `holds()`
past its last applied renewal. The default profile catches it first at seed 8 (201 of seeds 1–2000),
shrunk to one fault (`put-throttle holder 50.4 s`); `sim/sim.test.ts` asserts both outcomes on seeds 1–200.

**Mutants.** `sim/fixtures/mutants.ts` builds variants of the current ha-lease.ts by exact text
replacement (a replacement that stops matching throws, so a mutant never silently becomes the real
code); `--module mutant:<name>` runs one. Default profile, seeds 1–2000:

| Mutant | Caught | First seed | Property |
|---|---|---|---|
| planted (fixture above) | 201 / 2000 | 8 | I13 |
| `no-observe-wait`: takeover skips the 40 s unchanged-ETag wait | 7 / 2000 | 169 | I1s |
| `takeover-31s`: `takeoverAfterMs` 31 s | 0 / 2000 | — | not catchable here, see below |
| `fence-29s`: `fenceAfterMs` 29 s | 823 / 2000 | 2 | I13 |
| `holds-ignores-fence`: `holds()` checks the role only | 24 / 2000 | 40 | I13 |
| `fence-wall-clock`: the fence timer runs on the wall clock | 14 / 2000 | 27 | I13 |

`sim.test.ts` asserts each first catch (and that `takeover-31s` passes); the full sweep is
`bun tests/ha/sim/run.ts --module mutant:<name> --runs 2000`. `takeover-31s` is safe under the default
assumptions, by construction: a standby starts its unchanged-ETag clock when it first reads a version,
which is after the store applied it, and the old holder stops acting by apply + 29.004 s (the I13
bound). Any wait above that bound is safe in this world. The documented 40 s is slack for response
lag beyond the profile's 9 s: the real lease stays safe for lag up to 20 s, the 31 s mutant only up to
11 s, which only a profile outside the documented assumptions (a 10 s request timeout, ≤ 5 s freezes)
can show.

**Findings about the real ha-lease.ts** (not fixed here):

1. *Stale leader after a freeze* (adversarial, I1s, e.g.
   `bun tests/ha/sim/run.ts --profile adversarial --runs 1 --seed 3371 --keep 6,7`): `lastConfirmedAt`
   is stamped when the renewal's 200 is processed, not when the request was sent. A primary on a slow
   link, frozen for 47 s between the store applying a renewal (180.7 s) and the process reading the
   200, resumes at 229 s, sets `lastConfirmedAt = now`, and acts at epoch 1 for up to 20 s while
   another node has held epoch 2 since 224.4 s. Any response lag over 20 s (freeze, GC pause, a slow
   link with no request timeout) does this; over 10 s breaks the one-TTL bound (I13, adversarial seed
   140). Stamping the monotonic time before the request (or before the read) closes it;
   `S3ObjectStore` also needs a request timeout. That fix does **not** cover a pause between `holds()`
   and the write it admits: a process that passes `holds()`, then stalls (GC, SIGSTOP, a slow disk)
   past its fence window, still writes as a deposed primary. Only the write's target checking the
   epoch (a fencing token: the writer sends its epoch, the target refuses one below the highest it
   has seen) closes that, and the simulator, which judges `holds()` at an instant, cannot see it.
2. *A node never retakes a lease that names it* (liveness, default profile, 78 of 2000 seeds; every
   stall is this): when the lease names this node but the process is not `primary` at that epoch
   (restarted after its lease expired, re-seeded after a fence, or its own takeover's response was
   lost), `tick()` follows it as "an earlier term" and returns before the takeover branch. Another
   node can take over; this one never can. With one control node, or one promotable node, there is no
   primary until `forcePromote()`. Replay: `bun tests/ha/sim/run.ts --contenders 1 --seed 1 --trace`.
3. *Stale reads move a follower's epoch backwards* (adversarial, I2, seed 283): `status().epoch` takes
   whatever the last read said. Agents must keep the highest epoch themselves (§6.3 says they do).
