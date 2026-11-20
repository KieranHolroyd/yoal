-- Object-store kinds for backup targets (HA-PLAN W3, G17; HA Wave 1 lane E). Additive only.
--
-- `backup_targets.kind` keeps its 0019 CHECK ('local','s3'): 's3' now means "an object store" and
-- `store_kind` says which, so no table rebuild is needed (the CLUSTERING §13.5 pattern). The API
-- kinds 'azure' and 'gcs' are rows with kind = 's3' and that store_kind. Every existing object-store
-- row is backfilled as 's3' and behaves exactly as before; local rows keep store_kind NULL.
--
-- `store_options_json` holds the kind's credential-free options (Azure account and container, an
-- emulator endpoint, ...). Credentials stay in the sealed columns: for 's3' the key id and secret
-- as today; for 'azure' and 'gcs' the credential JSON (account key or SAS token, service-account
-- file) in `secret_sealed`, with `access_key_sealed` NULL.
--
-- The platform store is configured in yoal.env (YOAL_OBJECT_STORE), not here: the control plane
-- needs it before it opens anything else, and its secrets live with the other platform keys.
-- Old `database_pitr.repo_json` values have no `store` and keep parsing as S3.
ALTER TABLE backup_targets ADD COLUMN store_kind TEXT
  CHECK (store_kind IS NULL OR store_kind IN ('s3','azure','gcs'));
ALTER TABLE backup_targets ADD COLUMN store_options_json TEXT NOT NULL DEFAULT '{}';
-- Write-once retention per target: S3 object lock, an Azure immutability policy, a GCS retention
-- policy. NULL with object_lock = 1 means the bucket's own default, as today.
ALTER TABLE backup_targets ADD COLUMN immutable_retention_days INTEGER;
UPDATE backup_targets SET store_kind = 's3' WHERE kind = 's3' AND store_kind IS NULL;
