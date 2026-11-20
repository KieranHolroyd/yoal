# tests/ha — the HA checker and the lease simulator

HA-PLAN §4 W1 (bullets 3–4). Two tools:

| Path | What it is |
|---|---|
| `checker/` | The **checker**: a client that writes numbered rows and reads them back through the public route, plus invariants I1–I7 (CLUSTERING §19.1) and I11–I16 (HA-PLAN §1.3) as pure functions over its request log and the lab's observations. |
| `checker/app/` | The **checker app** it talks to, deployable on Yoal as a process or container app with a Postgres database attached. |
| `sim/` | The **deterministic simulator** for `ControlLease` (`packages/core/src/ha-lease.ts`). |

`bun test tests/ha` runs all unit tests in about 3 s. tests/ha is not a workspace package; type-check
it with `node_modules/.bin/tsc -p tests/ha` (not part of `bun run check`). zod comes from
`packages/contracts`' install through `checker/zod.ts`.

## The checker

```sh
bun tests/ha/checker/cli.ts --url http://<ingress> [--host <Host header>] --duration-s 300 --rate 20 \
  --seed 7 [--observe obs.jsonl] --out report.json [--log requests.json] \
  [--timeout-ms 5000] [--rpo-ms 0] [--db-lease-ttl-ms 30000]
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
- `lostAcknowledgedWrites`: acknowledged rows the final read answers 404.
- `duplicateSingletonRuns`: extra starts per (job, run), counted from the app's records and from
  `singleton` observations separately (never summed). App records from before the run (more than 60 s
  before it started) are ignored, since the table outlives one run.

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

| Inv. | Reads | Fails when |
|---|---|---|
| I1 | `lease {epoch, holds}` from each control node (scope `control`, the default); `write-attempt {target:'control', epoch, accepted}` | two nodes `holds:true` at once; control writes accepted by two nodes in one epoch |
| I2 | `epoch {epoch, source?}`; node `lease {epoch}`; `lease` from node `arbiter` `{epoch, holder}` | a node's epoch (per source) goes down; the arbiter's epoch goes down, changes holder without +1, or names two holders |
| I3 | `db-role {database, generation, role, acceptingWrites?}` | two primaries in one generation; two nodes primary and accepting writes at once |
| I4 | the app's `/singletons`; `singleton {job, run, event?:'start'}` | a (job, run) started twice |
| I5 | `mount {volume, mode:'rw'\|'ro'\|'none'}` (kind added to the contract); `write-attempt {target:'volume', volume, accepted}` | a volume rw on two nodes; a write from a node without the rw mount |
| I6 | the checker's own log; `db-role {role:'primary', promotion}` for `--rpo-ms` | an acknowledged row is gone, differs, or cannot be verified (losses within `--rpo-ms` before a promotion are noted, not failed) |
| I7 | `fence {component?, fenced}`; `write-attempt {target, accepted}` | a fenced node accepts a write for the fenced component. Observed only once a write is attempted on a fenced node |
| I11 | `fault {fault:'control-down' or target:'control', state:'start'\|'end', id?}`; the checker's log | a request inside a control-down window fails while no other fault is open |
| I12 | `lease` from `arbiter` `{scope:'database', database, syncSet}`; `db-role {role:'primary', promotion:'auto'}` | an automatic promotion outside the latest recorded synchronous set, or with none recorded |
| I13 | member `lease {scope:'database', database, holds, ttlMs?}` (each confirmed renewal); `write-attempt {target:'database', accepted}` or `db-role {role:'primary', acceptingWrites:true}` | a member accepts writes more than one TTL after its last `holds:true` |
| I14 | `ingress {ready?, inRotation?}` (ready = can serve: routes converged, releases present, certificates loaded; a lame-duck ingress is still ready); `route {converged}` without `copy` | an ingress in rotation while not ready or not converged |
| I15 | `route {copy, event:'added'\|'started'\|'removed'\|'stopped'}`; the `x-checker-copy` of each response | a copy stopped while still in the upstreams; a request that started after the copy left the upstreams reached it |
| I16 | `release-command {release, event:'start'\|'end'\|'rollout-start', ok?}`; app singletons with job `release:<id>` | a release command started twice; a rollout started before a successful end |

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

## The simulator

```sh
bun tests/ha/sim/run.ts --runs 2000                    # ha-sim CI: the real lease, default profile
bun tests/ha/sim/run.ts --seed 42 --trace              # replay one seed and print its trace
bun tests/ha/sim/run.ts --seed 42 --runs 1 --keep 3,7  # replay a shrunk fault schedule
bun tests/ha/sim/run.ts --module planted --runs 500 --expect-violation
bun tests/ha/sim/run.ts --profile adversarial --runs 2000   # outside the lease's assumptions
```

Seeds run from `--seed` (1) to `--seed + --runs − 1`. A failing seed is shrunk (greedy delta debugging
over its fault list) and printed with its replay command and trace. A seed replays exactly: one
seeded PRNG for the schedule, one for clocks, one for runtime draws, and a discrete-event loop that
resumes the lease's `await`s only when it delivers a response. Other flags: `--module real|planted|<path>`,
`--contenders n`, `--verbose` (every request), `--no-shrink`, `--max-report`, `--max-lines`, `--show-stalls`.

**World.** 2–4 contenders, each a `ControlLease` from the module under test, with its own monotonic
clock (rate drift) and wall clock (offset, NTP steps); a store with one linearizable object and
conditional PUT (412 on a stale ETag); store `Date` headers jittered between frontends and truncated
to the second; a network with per-leg delays. Faults: partitions (refused or black-holed), slow links,
process freezes (SIGSTOP), crashes and restarts, store 5xx before or after applying a write, PUT
throttling (503 on PUTs only), lost responses after the store acted, 501 episodes, spurious 409s,
wall-clock steps, promotion-gate changes, planned switchovers (`release()`, with writes stopped first)
and break-glass `forcePromote()` (after stopping every node that thinks it is primary). An operator
re-seeds fenced nodes after 20–180 s; at 600 s everything heals; runs are 780 s simulated.

**Properties**, after every event and at every proof deadline. *Acting* means `holds()` on a live,
unfrozen process that is not mid-release.

| | Property |
|---|---|
| I1 | at most one contender acts at any instant (no fencing margin is granted) |
| I1s | a contender acts only while the store names it, unreleased, at its epoch |
| I2 | the stored epoch never decreases and rises by exactly 1 per new holder; no process sees its epoch go down |
| I13 | a contender acts at most one TTL (30 s) after the store *applied* its last renewal, takeover or bootstrap (the I7/I13 fence-window shape) |

Liveness (a primary exists at the end, after the heal) is reported, never failed.

**Profiles.** `default` holds the assumptions the lease's 20 s / 40 s argument needs: a response is
acted on within 10 s of the store applying it (legs ≤ 4 s, freezes ≤ 5 s and never chained), ≤ 100 ppm
drift, requests time out (10 s), a linearizable store, and an honest operator. `adversarial` drops
them: legs to 20 s, freezes to 90 s, 1000 ppm drift, no request timeout (as `S3ObjectStore` has
none today), stale reads and responses without a `Date`.

**Planted bug.** `sim/fixtures/ha-lease-planted.ts` is ha-lease.ts with one line added: a primary's
GET of its own record counts as a confirmed renewal. With PUTs throttled it keeps passing `holds()`
past its last applied renewal. The default profile catches it first at seed 25 (29 of seeds 1–500),
shrunk to one fault (`put-throttle n0 82.7 s`); `sim/sim.test.ts` asserts both outcomes on seeds 1–200.

**Findings about the real ha-lease.ts** (not fixed here):

1. *Stale leader after a freeze* (adversarial, I1s, e.g. seed 7477, `--keep 5,2,9,6`): `lastConfirmedAt`
   is stamped when the renewal's 200 is processed, not when the request was sent. A primary frozen
   for 68 s between the store applying a renewal and the process reading the 200 resumes, sets
   `lastConfirmedAt = now`, and acts at epoch 1 for up to 20 s while another node has held epoch 2
   since 406 s. Any response lag over 20 s (freeze, GC pause, a slow link with no request timeout) does
   this; over 10 s breaks the one-TTL bound (I13, seed 66). Stamping the monotonic time before the
   request (or before the read) closes it; `S3ObjectStore` also needs a request timeout.
2. *A node never retakes a lease that names it* (liveness, default profile, 88 of 2000 seeds; every
   stall is this): when the lease names this node but the process is not `primary` at that epoch
   (restarted after its lease expired, re-seeded after a fence, or its own takeover's response was
   lost), `tick()` follows it as "an earlier term" and returns before the takeover branch. Another
   node can take over; this one never can. With one control node, or one promotable node, there is no
   primary until `forcePromote()`. Replay: `bun tests/ha/sim/run.ts --contenders 1 --seed 1 --trace`.
3. *Stale reads move a follower's epoch backwards* (adversarial, I2, seed 21): `status().epoch` takes
   whatever the last read said. Agents must keep the highest epoch themselves (§6.3 says they do).
