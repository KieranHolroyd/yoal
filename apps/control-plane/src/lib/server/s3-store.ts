/**
 * The platform S3 store (`R2_*`) has what it needs: a bucket and keys, and either an R2 account id
 * or an explicit endpoint (any S3 store, `install.sh --object-store s3://`). The account id only
 * derives an R2 endpoint, so with `R2_ENDPOINT` it is not needed.
 */
export function s3StoreConfigured(values: Record<string, string | undefined>): boolean {
	return Boolean(values.R2_BUCKET && values.R2_ACCESS_KEY_ID && values.R2_SECRET_ACCESS_KEY && (values.R2_ACCOUNT_ID || values.R2_ENDPOINT));
}
