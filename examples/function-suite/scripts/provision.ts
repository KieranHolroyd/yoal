#!/usr/bin/env bun
/**
 * Provision everything function-suite binds to, then deploy it with the real `yoal deploy`.
 * Safe to re-run: existing resources and attachments are reused.
 *
 *   YOAL_URL=https://control.example.com YOAL_TOKEN=yoal_… bun scripts/provision.ts
 *
 * Creates (names come from wrangler.jsonc so the two never drift):
 *   project function-suite (+ function-suite-companion)  runtime "function"
 *   storage  <yoal.storage.BUCKET> with bucket <bucket_name>, attached read-write
 *   database <yoal.hyperdrive.HYPERDRIVE> (Postgres + PgBouncer), attached
 *   broker   <--broker> (NATS JetStream), attached; queues created
 *   event rule: storage uploads under events/ → suite-events
 *   project secret SUITE_SECRET (random; only its SHA-256 is kept locally)
 *   app errors enabled (SENTRY_DSN is injected into the function)
 */
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	ApiError,
	EXAMPLE_DIR,
	REPO_ROOT,
	apiFromEnv,
	dim,
	green,
	poll,
	readState,
	readWrangler,
	red,
	sha256Hex,
	writeState,
	yellow,
} from './lib.ts';

const { values: flags } = parseArgs({
	options: {
		url: { type: 'string' },
		token: { type: 'string' },
		slug: { type: 'string' },
		broker: { type: 'string', default: 'function-suite' },
		placement: { type: 'string', default: 'edge' },
		cli: { type: 'string' },
		'rotate-secret': { type: 'boolean', default: false },
		'no-events': { type: 'boolean', default: false },
		'no-app-errors': { type: 'boolean', default: false },
		'no-deploy': { type: 'boolean', default: false },
		help: { type: 'boolean', short: 'h', default: false },
	},
});

if (flags.help) {
	console.log(`Usage: bun scripts/provision.ts [options]

  --url, --token        Platform URL and API key (default: $YOAL_URL, $YOAL_TOKEN)
  --slug <slug>         Project slug (default: wrangler.jsonc "name")
  --broker <name>       Managed broker for the queues (default: function-suite)
  --placement <node>    edge | auto | node id, for the project and its services (default: edge)
  --cli "<command>"     How to run the Yoal CLI (default: bun <repo>/apps/cli/src/main.ts)
  --rotate-secret       Set a new SUITE_SECRET version
  --no-events           Skip the storage event rule (the events check will fail)
  --no-app-errors       Leave app errors as they are
  --no-deploy           Configure only`);
	process.exit(0);
}

const api = apiFromEnv(flags);
if (!api) {
	console.error(red('Set YOAL_URL and YOAL_TOKEN (or pass --url/--token).'));
	process.exit(2);
}

const wrangler = readWrangler();
const companionWrangler = readWrangler(resolve(EXAMPLE_DIR, 'companion', 'wrangler.jsonc'));
const slug: string = flags.slug ?? wrangler.name;
const companionSlug: string = companionWrangler.name;
const r2 = wrangler.r2_buckets[0];
const bucket: string = r2.bucket_name;
const storageName: string = wrangler.yoal.storage[r2.binding] ?? bucket;
const databaseName: string = wrangler.yoal.hyperdrive[wrangler.hyperdrive[0].binding];
const broker = flags.broker!;
const queues: string[] = [
	...new Set<string>([
		...wrangler.queues.producers.map((p: { queue: string }) => p.queue),
		...wrangler.queues.consumers.flatMap((c: { queue: string; dead_letter_queue?: string }) =>
			c.dead_letter_queue ? [c.queue, c.dead_letter_queue] : [c.queue],
		),
	]),
];
const eventsQueue = 'suite-events';
const cli = flags.cli?.split(' ') ?? ['bun', resolve(REPO_ROOT, 'apps/cli/src/main.ts')];
const state = readState();

const step = (text: string) => console.log(`\n${green('▸')} ${text}`);
const note = (text: string) => console.log(`  ${dim(text)}`);

async function ensureProject(projectSlug: string): Promise<{ id: string; productionUrl?: string }> {
	const existing = await api!.find(`/projects/${projectSlug}`);
	const project = existing?.project ?? existing;
	if (project?.id) {
		if (project.runtime && project.runtime !== 'function')
			throw new Error(`Project ${projectSlug} exists with runtime "${project.runtime}"; pick another --slug.`);
		note(`project ${projectSlug} exists`);
		return project;
	}
	const created = await api!.post('/projects', { slug: projectSlug, name: projectSlug, runtime: 'function', placement: flags.placement });
	note(`created project ${projectSlug}`);
	return created.project ?? created;
}

/** Create a managed service (storage/database/broker) or attach the one that exists. */
async function ensureService(kind: 'storage' | 'databases' | 'brokers', name: string, create: Record<string, unknown>, attach: Record<string, unknown>) {
	const key = kind === 'storage' ? 'storage' : kind === 'databases' ? 'database' : 'broker';
	const existing = await api!.find(`/${kind}/${name}`);
	if (!existing) {
		await api!.post(`/${kind}`, { name, placement: flags.placement, project: slug, ...create });
		note(`created ${key} ${name} and attached it to ${slug}`);
		return;
	}
	note(`${key} ${name} exists (${existing[key]?.status ?? existing.status ?? '?'})`);
	const { attachments } = await api!.get<{ attachments: Array<Record<string, string>> }>(`/projects/${slug}/${kind}`);
	const nameField = `${key}Name`;
	if (attachments.some((a) => a[nameField] === name)) {
		note(`already attached to ${slug}`);
		return;
	}
	await api!.post(`/projects/${slug}/${kind}`, { [key]: name, ...attach });
	note(`attached ${key} ${name} to ${slug}`);
}

async function waitRunning(kind: 'storage' | 'databases' | 'brokers', name: string) {
	const key = kind === 'storage' ? 'storage' : kind === 'databases' ? 'database' : 'broker';
	const view = await poll(`${key} ${name} to run`, 5 * 60_000, async () => {
		const body = await api!.get(`/${kind}/${name}`);
		const status = (body[key] ?? body).status;
		if (status === 'failed') throw new Error(`${key} ${name} failed: ${(body[key] ?? body).message ?? ''}`);
		return status === 'running' && (body[key] ?? body);
	}, 3000);
	note(`${key} ${name} is running on ${view.nodeName ?? view.nodeId ?? '?'}`);
}

function runCli(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
	const result = Bun.spawnSync([...cli, ...args], {
		cwd,
		env: { ...process.env, YOAL_URL: api!.baseUrl, YOAL_TOKEN: flags.token ?? process.env.YOAL_TOKEN },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	return { ok: result.exitCode === 0, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function deploy(dir: string, projectSlug: string) {
	const result = runCli(['deploy', dir, '--project', projectSlug, '--message', 'function-suite provision'], dir);
	for (const line of `${result.stdout}${result.stderr}`.trim().split('\n')) note(line);
	if (!result.ok) throw new Error(`yoal deploy ${projectSlug} failed`);
}

try {
	step(`Project ${slug} on ${api.baseUrl}`);
	const project = await ensureProject(slug);

	step(`Object storage ${storageName} (bucket ${bucket})`);
	await ensureService('storage', storageName, { buckets: [bucket] }, { grants: [{ bucket, mode: 'read-write' }] });
	const storageView = await api.get(`/storage/${storageName}`);
	const buckets: Array<{ name: string }> = (storageView.storage ?? storageView).buckets ?? [];
	if (!buckets.some((b) => b.name === bucket)) {
		await api.post(`/storage/${storageName}/buckets`, { name: bucket });
		note(`created bucket ${bucket}`);
	}

	step(`Postgres ${databaseName} (Hyperdrive)`);
	await ensureService('databases', databaseName, { engine: 'postgres', pooler: true }, {});

	step(`Broker ${broker} (queues: ${queues.join(', ')})`);
	await ensureService('brokers', broker, { engine: 'nats' }, {});

	step('Waiting for the services to run');
	await Promise.all([waitRunning('storage', storageName), waitRunning('databases', databaseName), waitRunning('brokers', broker)]);
	for (const queue of queues) {
		try {
			await api.request('POST', `/brokers/${broker}/queues?wait=20`, { queue }, 30_000);
			note(`queue ${queue} ready`);
		} catch (error) {
			// The agent also creates streams for consumers and dead-letter queues on deploy.
			note(yellow(`queue ${queue}: ${error instanceof Error ? error.message : error}`));
		}
	}

	let eventRuleId = state.eventRuleId;
	if (!flags['no-events']) {
		step(`Event rule: ${storageName}/${bucket} events/* → ${broker}/${eventsQueue}`);
		const { rules } = await api.get<{ rules: Array<Record<string, any>> }>('/events');
		const existing = rules.find(
			(rule) => rule.source === 'storage' && rule.queue === eventsQueue && rule.broker === broker && rule.filter?.bucket === bucket,
		);
		if (existing) {
			eventRuleId = existing.id;
			note(`rule ${existing.id} exists (${existing.deliveries?.delivered ?? 0} delivered in 24 h)`);
		} else {
			const { rule } = await api.post('/events', {
				source: 'storage',
				storage: storageName,
				bucket,
				prefix: 'events/',
				broker,
				queue: eventsQueue,
				description: 'function-suite: storage events check',
			});
			eventRuleId = rule.id;
			note(`created rule ${rule.id}`);
		}
	}

	step('Project secret SUITE_SECRET');
	const { secrets } = await api.get<{ secrets: Array<{ name: string; projectId: string | null; version: number }> }>('/secrets');
	const current = secrets.find((secret) => secret.name === 'SUITE_SECRET' && secret.projectId === project.id);
	let secretSha256 = state.secretSha256;
	if (!current || flags['rotate-secret'] || !secretSha256) {
		const value = randomBytes(24).toString('base64url');
		const saved = await api.post('/secrets', { name: 'SUITE_SECRET', value, projectId: project.id });
		secretSha256 = await sha256Hex(value);
		note(`set version ${saved.version ?? saved.secret?.version ?? '?'} (sha256 ${secretSha256.slice(0, 12)}…)`);
	} else {
		note(`version ${current.version} exists; pass --rotate-secret for a new one`);
	}

	if (!flags['no-app-errors']) {
		step('App errors (SENTRY_DSN)');
		try {
			await api.patch(`/projects/${slug}/errors/settings`, { enabled: true });
			note('enabled');
		} catch (error) {
			note(yellow(`not enabled: ${error instanceof Error ? error.message : error}`));
		}
	}

	const idleStopSeconds: number = wrangler.yoal.idleStopSeconds;
	writeState({
		...state,
		slug,
		projectId: project.id,
		companion: companionSlug,
		storage: storageName,
		bucket,
		database: databaseName,
		broker,
		queues,
		eventRuleId,
		secretSha256,
		idleStopSeconds,
		url: project.productionUrl ?? state.url,
		provisionedAt: new Date().toISOString(),
	});

	if (flags['no-deploy']) {
		console.log(`\n${green('Configured.')} Deploy with: yoal deploy ${EXAMPLE_DIR} --project ${slug}`);
		process.exit(0);
	}

	if (!existsSync(resolve(EXAMPLE_DIR, 'node_modules', 'postgres'))) {
		step('bun install');
		const install = Bun.spawnSync(['bun', 'install'], { cwd: EXAMPLE_DIR, stdout: 'inherit', stderr: 'inherit' });
		if (install.exitCode !== 0) throw new Error('bun install failed');
	}

	step(`Deploy ${companionSlug} (the COMPANION app binding needs it first)`);
	await ensureProject(companionSlug);
	deploy(resolve(EXAMPLE_DIR, 'companion'), companionSlug);

	step(`Deploy ${slug}`);
	deploy(EXAMPLE_DIR, slug);

	step('Function view');
	const fn = await api.get(`/projects/${slug}/function`);
	const view = fn.function ?? fn;
	const types = [...new Set<string>((view.bindings ?? []).map((b: { type: string }) => b.type))].sort();
	note(`bindings: ${types.join(', ')}`);
	note(`crons: ${(view.triggers?.crons ?? []).join(', ') || '-'} · queues: ${(view.triggers?.queues ?? []).map((q: { queue: string }) => q.queue).join(', ') || '-'}`);

	const refreshed = await api.get(`/projects/${slug}`);
	const url: string | undefined = (refreshed.project ?? refreshed).productionUrl;
	if (url) {
		step(`Waiting for ${url}/api/health`);
		// The edge answers 200 with a placeholder page before the route is live, so require the
		// Worker's own JSON body, not just the status.
		await poll('the function to answer', 3 * 60_000, async () => {
			const response = await fetch(`${url}/api/health`);
			const body = (await response.json().catch(() => null)) as { ok?: boolean } | null;
			return response.status === 200 && body?.ok === true;
		});
		note('healthy');
	}
	writeState({ ...readState(), url });

	console.log(`\n${green('Done.')} Run the suite:\n  bun scripts/suite.ts${url ? ` --base ${url}` : ''}`);
} catch (error) {
	console.error(`\n${red('✗')} ${error instanceof ApiError ? error.message : error instanceof Error ? error.message : error}`);
	process.exit(1);
}
