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
```
