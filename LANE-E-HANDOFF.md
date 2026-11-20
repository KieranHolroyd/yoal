# Lane E hand-back — W3 object-store backends

Branch: `ha/w1-e-object-stores`. Base merged in: `ha/integration` at `1cd872e9`.
Code + merge commit: `d9091929` (`feat(ha): W3 object-store backends — Azure Blob, GCS, S3 options`
merged with `Merge branch 'ha/integration'`). This hand-off file is one docs-only commit on top.

## 1. Verified, with the commands and results

| What | Command | Result |
|---|---|---|
| Types, every package | `bun run check` | all packages `Exited with code 0`; control-plane `svelte-check found 0 errors and 1 warning` (pre-existing `settings/registry` warning); `iam lint: no new role/kind checks` |
| Full suite | `bun test` | **6150 pass, 73 skip, 0 fail** (6223 tests / 560 files) on the merged tree |
| Conformance, all three, S7's 200 writers | `bun tests/object-store/conformance.e2e.ts minio azurite gcs --json /tmp/conformance-report.json` | **PASS on all three**, 200 writers × 5 generations, exactly one winner each |
| Managed-data e2e, all three | `bun tests/object-store/managed-data.e2e.ts` | **PASS**: real `pg_dump -Fc` → `putStream` → `getStream` (sha256 equal) → `pg_restore` → fixture checksum equal, on MinIO, Azurite and fake-gcs-server |

Conformance numbers from that run:

```
PASS  minio (s3):            19 passed, 0 skipped, 0 failed; conditional writes n=1211
      p50=85.29 ms p99=315.9 ms max=1022.38 ms; 200x5, winners 1/1/1/1/1,
      losers {"412":995}, throttled retries 205
PASS  azurite (azure):       18 passed, 1 skipped, 0 failed; n=1006
      p50=161.17 ms p99=1040.06 ms max=1070.81 ms; 200x5, winners 1/1/1/1/1,
      losers {"409":199,"412":796}, throttled retries 0
PASS  fake-gcs-server (gcs): 17 passed, 2 skipped, 0 failed; n=1006
      p50=59.68 ms p99=211.6 ms max=1018.36 ms; 200x5, winners 1/1/1/1/1,
      losers {"412":995}, throttled retries 0
```

The suite covers: put/get/exists/size (including empty objects), missing objects, keys with
spaces/unicode/reserved characters, known- and unknown-size streams, a 16 MiB streamed object both
ways, listing with prefixes/sizes/pagination (1,005 objects), delete, prefix scoping, presigned
GET/PUT, conditional create/replace/stale/missing, the active conditional probe, 200-writer
contention per generation, `testConnection`, immutability reporting (MinIO object-lock bucket) and
three timeout cases (a store that never answers, a body that stalls mid-stream, an upload the store
stops reading).

Emulators: pinned MinIO (`RELEASE.2025-09-07T16-13-09Z` by digest), Azurite 3.35.0 and
fake-gcs-server 1.52.2, all on 127.0.0.1 (`tests/object-store/emulators.ts`). No cloud credentials
or spend were used.

Skips, deliberately:
- Azurite `immutability is reported`: Azurite cannot configure a container immutability policy, so
  the case is skipped rather than faked.
- fake-gcs-server `presigned GET and PUT`: it does not serve the XML API/V4 URLs.
- fake-gcs-server `immutability is reported`: no retention-policy support.

## 2. Not verified, and why

- **Real Azure Blob Storage and real GCS**: no cloud credentials and no spend. Shared-key signing,
  service SAS signing, block uploads and GCS generation preconditions are proven against Azurite /
  fake-gcs-server only.
- **GCS service-account OAuth token exchange** (`ServiceAccountAuth`, RS256 JWT): never exercised;
  the emulator runs anonymously. Only the signing code path is compiled/typechecked.
- **GCS V4 presigned URLs**: not exercised (fake-gcs-server does not implement them). The GCS
  subject sets `presign: false`. Azure presigning *is* exercised (service SAS) and works against
  Azurite, but a presigned Azure PUT also requires the uploader to send `x-ms-blob-type:
  BlockBlob`; no URL can carry that header, and the conformance subject names it explicitly.
- **Real GCS pagination**: fake-gcs-server ignores `maxResults` above the result count and never
  returns a `nextPageToken`, so the client's token loop is only proven on real GCS by inspection.
  The list call asks for 5,000 (GCS clamps to 1,000 + token) so both stores return complete sets.
- **Immutability against a real service**: Azure container immutability-policy and GCS bucket
  retention-policy headers are parsed and reported, but only MinIO object lock proved the case.
- **S3/R2 cloud**: only MinIO; no R2 or AWS run.
- **Litestream configuration and pgBackRest `repo1-type=azure|gcs`**: these are rendered in
  `apps/helper/src/pitr.ts` and `apps/helper/src/identity.ts`, which belong to other lanes and were
  explicitly out of bounds. The core side is ready: `ObjectStoreTarget`/credentials, the
  `databasePitrStoreActivation` shape, `pitrActivationFor`, `pitrStoreProblem` (flag + node
  capability) and `createObjectStore`. No PITR env selection for Azure/GCS was added (see §3).
- **W3 exit as written, end-to-end**: the managed-data e2e passes per backend (§1) and a real dump
  restores from Azure Blob (Azurite), but the platform's own **restore drill** and a PITR restore
  from Azure were not run; they need the helper changes above.
- **Arbiter store selection**: Wave 9/Wave 3 work by plan. The `ConditionalStore` interface and the
  active probe that W9 needs are in place and pass on all three emulators.
- The pre-existing RustFS `tests/e2e/managed-data.e2e.ts` was not rerun; the new object-store
  managed-data e2e is the substitute and covers the three W3 backends.

## 3. Deviations

- **No migration.** `0125` was not used and no schema change was needed; foundation `0120` already
  has `store_kind`, `store_options_json`, `immutable_retention_days`.
- **No new flags.** `OBJECT_STORE_AZURE` / `OBJECT_STORE_GCS` already exist in `OPT_IN_FEATURES`,
  default off. Azure/GCS platform-store startup refuses the kind unless its flag is on; backup
  targets and PITR keep the foundation refusal.
- **Out-of-directory edits** (not forbidden, but worth naming):
  - `packages/contracts/src/database-backup.ts`: widened `DatabaseBackupLocation.kind` to
    `'azure' | 'gcs'` so a recorded managed-data backup can name its store.
  - `apps/control-plane/src/lib/server/{config,core}.ts`: platform-store selection
    (`YOAL_OBJECT_STORE=azure|gcs`, `YOAL_AZURE_*`, `YOAL_GCS_*`, `R2_REGION`, `R2_PATH_STYLE`).
  - `packages/core/src/ha-wave1-foundation.test.ts` and `backup-target-stores.test.ts`: the
    foundation tests asserted lane E's "not implemented" stubs; they now assert the real backend.
- **Conformance contract change**: `ConformanceSubject.presign` may be `{ putHeaders }`, so the
  Azure subject can tell the caller about `x-ms-blob-type`. Azure presigning is otherwise a plain
  SAS URL.
- **GCS conditional writes use a multipart upload.** `uploadType=media` silently ignores
  `ifGenerationMatch` on fake-gcs-server (and is not the documented precondition path), which would
  make a compare-and-swap a no-op. The multipart path is used only for `writeConditional`; large
  uploads still use media uploads.
- **Backup target update** for Azure/GCS allows only `name` and `writeOnly`; changing a location or
  rotating credentials needs a new target. The S3 update path is unchanged.
- **PITR repository env** still creates only an S3 repository (`YOAL_PITR_REPO_*`); no Azure/GCS
  environment keys were invented. Programmatic `DatabasePitrRepository` values with a `store` work.
- No `VERSION` bump.

## 4. Final commit

- Code + integration merge: `d9091929`
- Hand-off commit (this file): the tip of `ha/w1-e-object-stores` after `d9091929`.
