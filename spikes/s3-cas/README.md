# Spike S3 — conditional writes as the only lease arbiter

Plan: [CLUSTERING §15.2 S3](../../docs/CLUSTERING.md#152-the-six-spikes), §6.3; HA-PLAN §4 W2 S3.

## Question

Do **MinIO, Garage and RustFS**, run locally at pinned current versions, honour `If-Match` and
`If-None-Match: *` on `PUT` strongly enough to be the **only** arbiter of one primary? Two
acknowledged conflicting writes, or two views of one object, remove the foundation of §6.3.

R2, AWS S3, Azure Blob and GCS run later with credentials through the same rig: the target is an
endpoint, credentials and a bucket, with nothing store-specific in the checks. Azure Blob (ETag
conditions) and GCS (generation preconditions) arrive as small adapters for S7.

## Pass criteria (CLUSTERING §15.2, quoted)

> Exactly one 200 per epoch, never two holders; 409 or 412, never 200, for a stale `If-Match`;
> the ETag changes on every write; p99 PUT ≤ 300 ms; store time within 5 s of true time; 501 for
> an unsupported condition, never silent success.

Tightened for this spike (never loosened; recorded as deviations in docs/SPIKES.md):

- **T1** `If-None-Match: *` on an existing key is refused with 409 or 412, never 200.
- **T2** An unconditional `PUT` while another writer holds an `If-Match` view does not make that
  writer's later `If-Match` succeed: the holder's CAS must return 409/412.
- **T3** Read-after-write: a `GET` and a `HEAD` issued after a 200 return the ETag that 200 gave,
  every time (no stale view of the object).
- **T4** Delayed response: when the client times out on a conditional PUT that the store applied,
  a retry with the same `If-Match` returns 409/412 (never a second 200), and a re-read shows the
  applied write. A store that cannot be made to show this fails.
- **T5** `ControlLease` (`packages/core/src/ha-lease.ts`, unchanged) with three contenders against
  the store through its real S3 client: at no observed instant do two contenders both pass
  `holds()`, and epochs only rise.

"501 for an unsupported condition" is exercised with conditions the lease does not use but a store
could silently ignore: `If-Match` with a list or a weak ETag is out of scope; the rig sends
`If-None-Match` with a specific ETag (not `*`) on PUT, which S3 documents as unsupported. Pass is
any refusal (4xx/5xx) that is not 200; silent success (200, object replaced) fails.

## Fallback (agreed before the run; HA-PLAN W2 table)

**Per store: not offered as an arbiter.** A store that fails any criterion is refused by the
arbiter setup for the lease; installs on it get no automatic promotion (CLUSTERING §15.4 S3: fail
closed, control-plane promotion manual with a confirmed-dead isolation step). If every local store
fails, local installs need R2/S3/Azure/GCS for HA.

Only single-node deployments are tested. Multi-node and erasure-coded deployments could change
the answer and are recorded as untested.

## Running it

```sh
bun spikes/s3-cas/run-local.ts          # MinIO, Garage, RustFS in yoal-w0-s3-* containers, then removed
# or one target you already have:
S3_ENDPOINT=… S3_BUCKET=… S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… [S3_REGION=auto] bun spikes/s3-cas/spike.ts
# R2 and GCS (credentials from the environment only; output is scrubbed; the run prefix is emptied and re-listed):
set -a; . creds.env; set +a; bun spikes/s3-cas/run-cloud.ts > results.json   # STORES=r2,r2-identity,gcs ONLY=lease
```

## Result (2026-11-20)

All three local stores fail by the criteria as written. Numbers, per-condition codes and what they change
in the plan are in [docs/SPIKES.md § S3](../../docs/SPIKES.md). In short: Garage ignores the conditions;
MinIO and RustFS are correct CAS stores but have MD5 ETags and miss p99 at 200 writers. `ControlLease`
can overlap two holders when a write's answer arrives late (`client-late-confirm`).

## S7 — GCS generation preconditions as the only lease arbiter

Plan: HA-PLAN §4 W2 S7; CLUSTERING §6.3. Written before any S7 code (2026-11-20).

### Question

Can **Google Cloud Storage** be the only arbiter of one primary through its generation
preconditions on the JSON API (`ifGenerationMatch=<generation>` to replace,
`ifGenerationMatch=0` to create only)? The CAS token is the object's generation, not an ETag.

### Pass criteria (HA-PLAN W2 S7, as given)

- **S7.1** Exactly one winner per generation under 200 contending writers.
- **S7.2** A stale precondition is refused with 412.
- **S7.3** The generation changes on every write, including identical bodies, so there is no ABA.
- **S7.4** Store clock from the response `Date` header, within 5 s of true time.
- **S7.5** Behaviour under throttling (429/503) is recorded.
- **S7.6** p99 is reported both at 200 writers and sequentially.

Tightened for this spike (never loosened; recorded as deviations in docs/SPIKES.md):

- S7.1 is run with the S3 method unchanged: 10,000 attempts by 200 writers in lock-step rounds over
  60 s, plus a capped free-running flood. Every 200 must extend the one chain of generations from
  the created object, and the final object must be the last win. A throttled or failed answer
  (429/503/transport error) whose write in fact applied would break the chain, so it fails S7.1.
- S7.2 also covers `ifGenerationMatch=0` on an existing object, `ifGenerationMatch=<n>` on an absent
  object, and the ABA form (X→Y→X, then the generation read at the first X): all must be 412.
- The S3 tightenings apply unchanged: T2 (an unconditional write breaks the holder's precondition),
  T3 (read-after-write: a read after a 200 returns that generation), T4 (a held request or response
  never yields a second 200 or a lost winner).
- A malformed precondition (`ifGenerationMatch=abc`) must be refused, never silently ignored.
  S3-dialect `If-Match`/`If-None-Match` headers sent to the JSON API are recorded, not gated: the GCS
  adapter never sends them.
- S7.6 is a report, as the plan words it; the S3 bound (p99 ≤ 300 ms) is shown beside it for
  comparison only.

### Fallback (HA-PLAN W2 table)

**Not offered as an arbiter.** If GCS fails any criterion, the lease setup refuses a GCS bucket and
installs on GCS get no automatic promotion (fail closed; manual promotion with a confirmed-dead
isolation step).

### How it runs

A `gcs` adapter behind the existing `CasTarget` interface (JSON API, service-account OAuth via a
signed JWT, credentials from the environment only). The checks in `spike.ts` stay store-agnostic.
R2 runs the S3 criteria unchanged through the production `S3ObjectStore`, including `ControlLease`.
All objects live under `yoal-w0-spikes/<run-id>/` and are deleted at the end; the run proves the
prefix empty. Not run: AWS S3 and Azure Blob (no credentials).

### Result on R2 and GCS (2026-11-20)

**GCS passes S7.** **R2 fails S3** as the production client stands. R2 is a correct CAS store, but its ETag is
the body's MD5 (ABA → 200). Its edge also gzips JSON bodies of about 50 bytes or more and then serves a
*weak* ETag on GET/HEAD. That weak ETag can never satisfy `If-Match`, so the unchanged `ControlLease`
fenced on its first renewal and no standby could ever take over. The rig's `r2-identity` target
(`Accept-Encoding: identity` on reads) is the prototype fix: with it, T5 passes. Numbers:
[docs/SPIKES.md § S3 (R2) and S7 (GCS)](../../docs/SPIKES.md).
