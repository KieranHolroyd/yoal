/**
 * The installer's HA flags (HA-PLAN §6.2, §8 steps 1–2; Wave 5 lane B): `--profile`, `--zone`,
 * `--roles` and `--object-store <kind>://<name>`. Pure, so `main.ts` stays a thin caller and these
 * are tested without running an install.
 *
 * - `--profile` writes the same `YOAL_FEATURE_*` lines `yoal ha init` prints, from the same
 *   function (`haInitPlan`). There is no second flag store: the lines go into `yoal.env`, where
 *   every flag already lives. `single` (and no flag) writes nothing.
 * - `--object-store azure://…|gcs://…|s3://…` picks the W3 kind and its container or bucket.
 *   Credentials never come from the command line: from the environment (`YOAL_AZURE_*`,
 *   `YOAL_GCS_*`, `R2_*`) or `--object-store-credentials-file` (the same keys, one per line; for
 *   GCS also the service-account JSON itself). Azure and GCS are behind their `OBJECT_STORE_*`
 *   flags, so choosing one writes its flag line too: the control plane refuses the kind otherwise.
 */
import { nodeRoleSchema, nodeZoneSchema } from '../../packages/contracts/src/cluster.ts';
import { haInitPlan } from '../../packages/contracts/src/ha-init.ts';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { bucketNameSchema } from '../../packages/contracts/src/object-storage.ts';
import { PLATFORM_OBJECT_STORE_ENV, parsePlatformObjectStoreKind } from '../../packages/contracts/src/platform-config.ts';

export const INSTALL_PROFILES = ['single', 'ha', 'ha-dr'] as const;
export type InstallProfile = (typeof INSTALL_PROFILES)[number];

export function parseProfile(value: string): InstallProfile {
	if (!(INSTALL_PROFILES as readonly string[]).includes(value)) throw new Error(`--profile must be single, ha or ha-dr (got "${value}")`);
	return value as InstallProfile;
}

/** The `yoal.env` flag lines for a profile, exactly as `yoal ha init --profile <p>` prints them. */
export function profileFlagLines(profile: InstallProfile): Array<[string, string]> {
	if (profile === 'single') return [];
	return haInitPlan(profile).flags.map((flag) => {
		const [key, value] = flag.env.split('=') as [string, string];
		return [key, value];
	});
}

export function parseZone(value: string): string {
	const parsed = nodeZoneSchema.safeParse(value);
	if (!parsed.success) throw new Error(`--zone ${value}: use 1–32 lowercase letters, digits and single hyphens`);
	return parsed.data;
}

export function parseRoles(value: string): string[] {
	const roles = [...new Set(value.split(',').map((role) => role.trim()).filter(Boolean))];
	const bad = roles.filter((role) => !nodeRoleSchema.safeParse(role).success);
	if (roles.length === 0 || bad.length > 0)
		throw new Error(`--roles ${value}: use a comma-separated list of ${nodeRoleSchema.options.join(', ')}`);
	return roles;
}

export type ObjectStoreChoice = { kind: 'local' | 'r2' } | { kind: 'azure' | 'gcs' | 's3'; name: string };

/** Where a GCS service-account key is copied, so the control plane (user yoal) can read it. */
export const GCS_CREDENTIALS_COPY = '/etc/yoal/gcs-credentials.json';

/** `local`, `r2`, or `azure://<container>`, `gcs://<bucket>`, `s3://<bucket>`. */
export function parseObjectStore(value: string): ObjectStoreChoice {
	if (value === 'local' || value === 'r2') return { kind: value };
	const match = /^(azure|gcs|s3):\/\/([^/?#]+)\/?$/.exec(value);
	if (!match) throw new Error(`--object-store must be local, r2, azure://<container>, gcs://<bucket> or s3://<bucket> (got "${value}")`);
	const [, kind, name] = match as unknown as [string, 'azure' | 'gcs' | 's3', string];
	// The platform's own bucket rules (the same schema Settings and blueprints use); Azure container
	// names follow the same shape.
	const valid = bucketNameSchema.safeParse(name);
	if (!valid.success) throw new Error(`--object-store ${value}: "${name}" is not a valid container or bucket name: ${valid.error.issues[0]?.message ?? ''}`);
	return { kind, name };
}

export interface ObjectStoreSources {
	env: Record<string, string | undefined>;
	file?: ReadonlyMap<string, string>;
	existing?: ReadonlyMap<string, string>;
	credentialsPath?: string;
	credentialsJson?: boolean;
	/** `--object-store-region`: required for `s3://`. */
	region?: string;
	/** Existence check for a credentials path (tests pass their own). */
	exists?: (path: string) => boolean;
}

/**
 * The `yoal.env` keys for an `azure://`, `gcs://` or `s3://` store. `sources` is the process
 * environment, then the credentials file (`file`), then the existing `yoal.env`; a key the kind does
 * not read is ignored. `missing` names each required key that no source had, or that is unusable.
 * `copy` is a file the installer must copy into place (the GCS key) before it writes `yoal.env`.
 */
export function objectStoreEnv(
	choice: { kind: 'azure' | 'gcs' | 's3'; name: string },
	sources: ObjectStoreSources,
): { set: Map<string, string>; missing: string[]; copy?: { from: string; to: string } } {
	const allowed = PLATFORM_OBJECT_STORE_ENV[choice.kind === 's3' ? 'r2' : choice.kind] as readonly string[];
	const pick = (key: string): string | undefined =>
		allowed.includes(key) ? sources.env[key]?.trim() || sources.file?.get(key)?.trim() || sources.existing?.get(key)?.trim() || undefined : undefined;
	const exists = sources.exists ?? existsSync;
	const set = new Map<string, string>();
	const missing: string[] = [];
	let copy: { from: string; to: string } | undefined;
	const copyKeys = (keys: readonly string[]) => {
		for (const key of keys) {
			const value = pick(key);
			if (value) set.set(key, value);
		}
	};
	const kind = (value: string) => {
		// Written only as a value the control plane's own parser accepts.
		const parsed = parsePlatformObjectStoreKind(value);
		if (!parsed) throw new Error(`internal: ${value} is not a platform object store kind`);
		set.set('YOAL_OBJECT_STORE', parsed);
	};
	if (choice.kind === 'azure') {
		kind('azure');
		set.set('YOAL_FEATURE_OBJECT_STORE_AZURE', '1');
		copyKeys(['YOAL_AZURE_ACCOUNT', 'YOAL_AZURE_ACCOUNT_KEY', 'YOAL_AZURE_SAS_TOKEN', 'YOAL_AZURE_ENDPOINT']);
		set.set('YOAL_AZURE_CONTAINER', choice.name);
		if (!set.has('YOAL_AZURE_ACCOUNT')) missing.push('YOAL_AZURE_ACCOUNT');
		if (!set.has('YOAL_AZURE_ACCOUNT_KEY') && !set.has('YOAL_AZURE_SAS_TOKEN')) missing.push('YOAL_AZURE_ACCOUNT_KEY or YOAL_AZURE_SAS_TOKEN');
	} else if (choice.kind === 'gcs') {
		kind('gcs');
		set.set('YOAL_FEATURE_OBJECT_STORE_GCS', '1');
		copyKeys(['YOAL_GCS_ENDPOINT']);
		set.set('YOAL_GCS_BUCKET', choice.name);
		// The service-account JSON passed as the credentials file, else the path the sources name.
		const key = sources.credentialsJson && sources.credentialsPath ? sources.credentialsPath : pick('YOAL_GCS_CREDENTIALS_FILE');
		if (!key) missing.push('YOAL_GCS_CREDENTIALS_FILE');
		else if (key === GCS_CREDENTIALS_COPY) set.set('YOAL_GCS_CREDENTIALS_FILE', key);
		else if (!isAbsolute(key)) missing.push('YOAL_GCS_CREDENTIALS_FILE (an absolute path)');
		else if (!exists(key)) missing.push(`YOAL_GCS_CREDENTIALS_FILE (${key} does not exist)`);
		else {
			copy = { from: key, to: GCS_CREDENTIALS_COPY };
			set.set('YOAL_GCS_CREDENTIALS_FILE', GCS_CREDENTIALS_COPY);
		}
	} else {
		// The platform's S3 kind: YOAL_OBJECT_STORE=r2 with an explicit endpoint and region (W3).
		kind('r2');
		copyKeys(['R2_ENDPOINT', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_PATH_STYLE']);
		const region = sources.region?.trim() || pick('R2_REGION');
		if (region) set.set('R2_REGION', region);
		set.set('R2_BUCKET', choice.name);
		const endpoint = set.get('R2_ENDPOINT');
		if (!endpoint) missing.push('R2_ENDPOINT');
		else if (!/^https:\/\/[^/\s]+/.test(endpoint)) missing.push('R2_ENDPOINT (https://)');
		if (!region) missing.push('--object-store-region (R2_REGION)');
		for (const key of ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) if (!set.has(key)) missing.push(key);
	}
	return { set, missing, ...(copy ? { copy } : {}) };
}
