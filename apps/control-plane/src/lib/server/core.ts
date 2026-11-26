import { readFileSync } from 'node:fs';
import { building } from '$app/env';
import {
	EmailNotifier,
	LocalObjectStore,
	R2ObjectStore,
	SmsNotifier,
	createObjectStore,
	TelemetryStore,
	TwilioSmsTransport,
	chatNotifiersFromEnv,
	webhookNotifierFor,
	clickhouseFromEnv,
	coreConfigFromEnv,
	createCore,
	ClickHouseLogStore,
	LogIndexer,
	featureEnabled,
	type Notifier
} from '@yoal/core';
import {
	alertEmail,
	alertSms,
	azureStore,
	clickhouseEnv,
	dataDir,
	edgeNodeId,
	gcsStore,
	masterKey,
	storageGatewayPort,
	storageGatewayUrl,
	objectStoreKind,
	objectStoreSecret,
	platformOrigin,
	contentDomain,
	r2,
	siteCookieSecret,
	twilio,
	webhookUrl,
	webhookSecret,
	features
} from './config';
import { db, sqlite } from './db';
import { platformVersion } from './version';
import { pushNotifier } from './push';
import { platformMail } from './platform-mail';
import { updateSource } from './self-update';

/**
 * The platform object store: local by default, R2/S3 as before, Azure Blob or GCS for W3 installs.
 * Its secrets live in yoal.env with every other platform credential; the store itself is built
 * once here, before the service layer starts.
 */
const objectStore =
	objectStoreKind === 'r2' && r2
		? new R2ObjectStore(r2)
		: objectStoreKind === 'azure' && azureStore
			? createObjectStore(
					{ kind: 'azure', account: azureStore.account, container: azureStore.container, endpoint: azureStore.endpoint ?? null, pathPrefix: '', immutability: null },
					azureStore.accountKey
						? { kind: 'azure', accountKey: azureStore.accountKey }
						: azureStore.sasToken
							? { kind: 'azure', sasToken: azureStore.sasToken }
							: (() => {
									throw new Error('YOAL_OBJECT_STORE=azure needs YOAL_AZURE_ACCOUNT_KEY or YOAL_AZURE_SAS_TOKEN.');
								})(),
				)
			: objectStoreKind === 'gcs' && gcsStore
				? createObjectStore(
						{ kind: 'gcs', bucket: gcsStore.bucket, endpoint: gcsStore.endpoint ?? null, pathPrefix: '', immutability: null },
						{
							kind: 'gcs',
							serviceAccountJson: (() => {
								if (!gcsStore.credentialsFile)
									throw new Error('YOAL_OBJECT_STORE=gcs needs YOAL_GCS_CREDENTIALS_FILE.');
								return readFileSync(gcsStore.credentialsFile, 'utf8');
							})(),
						},
					)
				: new LocalObjectStore(`${dataDir}/objects`, platformOrigin, objectStoreSecret);

// Yoal Email when a mail node can take it, else the SMTP relay (D238); attached to the core below.
const emailTransport = platformMail;
const notifiers: Notifier[] = [];
if (alertEmail) notifiers.push(new EmailNotifier(emailTransport, alertEmail));
if (webhookUrl) notifiers.push(webhookNotifierFor(webhookUrl, { secret: webhookSecret }));
// Discord, Slack, Telegram, ntfy (Settings → Notifications).
notifiers.push(...chatNotifiersFromEnv(process.env));
if (twilio && alertSms.length)
	notifiers.push(new SmsNotifier(new TwilioSmsTransport(twilio), alertSms));

// Web Push to the installed dashboard app (Settings → Notifications, D108).
if (pushNotifier) notifiers.push(pushNotifier);

/** The single service layer shared by the dashboard, REST API, MCP server and CLI (DESIGN §3.2). */
export const core = createCore({
	db,
	sqlite,
	version: platformVersion,
	// The values resolved in ./config win; everything else (studio and database gateway ports, the
	// upload cap, the PITR repository, …) is read from the environment by the service layer itself
	// (docs/OPS.md §2.1, §2.5.1), so a variable documented there always reaches the platform.
	config: coreConfigFromEnv({
		dataDir,
		platformOrigin,
		contentDomain,
		objectStore,
		platformStore: r2
			? {
					kind: 'r2',
					s3: {
						endpoint: r2.endpoint ?? `https://${r2.accountId}.r2.cloudflarestorage.com`,
						bucket: r2.bucket,
						region: r2.region ?? 'auto',
						accessKeyId: r2.accessKeyId,
						secretAccessKey: r2.secretAccessKey,
						pathStyle: r2.forcePathStyle ?? true,
					},
				}
			: { kind: objectStoreKind ?? 'local' },
		masterKey,
		siteCookieSecret,
		objectStoreSecret,
		// Nodes should run this release (D99); the env value outlives the binary it was written for.
		desiredAgentVersion: platformVersion,
		releaseRepo: updateSource().repo,
		edgeNodeId,
		storageGatewayPort,
		storageGatewayUrl,
		notifiers,
		email: emailTransport,
		features
	})
});

platformMail.attach(core.email);

export { objectStore };

/**
 * ClickHouse telemetry (DESIGN §8, D101), over HTTP to the local `yoal-clickhouse` server.
 * Fail-open: if ClickHouse is down or unconfigured, the platform keeps serving, telemetry
 * reports unavailable, and the store reconnects by itself once the server answers. A
 * zero-downtime standby shares the server with the primary, so it needs no special case.
 */
export const telemetry = new TelemetryStore({
	...clickhouseFromEnv(clickhouseEnv),
	objectStore,
	onError: (error) => console.error('[telemetry]', error.message)
});
core.ctx.telemetry = telemetry;
// The Logs Explorer search index (docs/LOGS.md §4.2): only where ClickHouse is installed. The
// indexer is ticked from hooks.server.ts on the primary; `LOG_INDEX=0` stops it and sends every
// Explorer read back to lite mode (SQLite).
if (telemetry.installed) {
	const logIndexEnabled = () => featureEnabled(core.ctx.config, 'LOG_INDEX');
	core.ctx.logStoreClickhouse = new ClickHouseLogStore(telemetry, {
		enabled: logIndexEnabled,
		indexLagMs: () => core.ctx.logIndexer?.lagMs() ?? null
	});
	core.ctx.logIndexer = new LogIndexer(core.ctx, telemetry, { enabled: logIndexEnabled });
}
// Never connect while SvelteKit analyses the build.
if (!building) {
	void telemetry.open().catch((error) => console.error('[telemetry] open failed:', error));
}
