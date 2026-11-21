/**
 * The external prober (HA-PLAN W15).
 *
 * A deliberately tiny runner that lives outside the fleet: it probes public targets and POSTs one
 * signed-by-token report to the control plane. It holds no platform credentials beyond its
 * registration token and never reads desired state. If the fleet's control plane is unreachable,
 * the prober's silence is what the platform's `ha.prober_stale` alert notices.
 *
 * Usage:
 *   YOAL_PROBER_URL=https://control.example.com \
 *   YOAL_PROBER_TOKEN=yoalp_… \
 *   YOAL_PROBER_ID=prb_… \
 *   YOAL_PROBER_TARGETS='[{"target":"https://app.example.com/healthz","kind":"https"}]' \
 *   bun scripts/external-prober.ts
 *
 * Or: bun scripts/external-prober.ts --config /etc/yoal/prober.json [--once]
 */
import { promises as dns } from 'node:dns';
import { connect } from 'node:net';

interface TargetConfig {
	/** The public target string; also the stable id in the report. */
	target: string;
	kind?: 'http' | 'https' | 'tcp' | 'dns' | 'database' | 'other';
	/** Connection/request budget for this target. Default 5000 ms. */
	timeoutMs?: number;
	/** HTTP only: the status codes that count as up. Default 200–399. */
	expectStatus?: number[];
}

interface ProberConfig {
	url: string;
	token: string;
	proberId: string;
	intervalSeconds?: number;
	targets: TargetConfig[];
}

interface TargetReport {
	target: string;
	kind: 'http' | 'https' | 'tcp' | 'dns' | 'database' | 'other';
	status: 'up' | 'degraded' | 'down';
	statusCode: number | null;
	latencyMs: number | null;
	error: string | null;
	checkedAt: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;

function fromEnv(): ProberConfig {
	const url = process.env.YOAL_PROBER_URL;
	const token = process.env.YOAL_PROBER_TOKEN;
	const proberId = process.env.YOAL_PROBER_ID;
	if (!url || !token || !proberId)
		throw new Error('Set YOAL_PROBER_URL, YOAL_PROBER_TOKEN and YOAL_PROBER_ID, or pass --config <file>.');
	let targets: TargetConfig[];
	try {
		targets = JSON.parse(process.env.YOAL_PROBER_TARGETS ?? '[]') as TargetConfig[];
	} catch {
		throw new Error('YOAL_PROBER_TARGETS must be a JSON array of targets.');
	}
	if (!Array.isArray(targets) || targets.length === 0) throw new Error('YOAL_PROBER_TARGETS must contain at least one target.');
	return { url, token, proberId, intervalSeconds: Number(process.env.YOAL_PROBER_INTERVAL ?? 60), targets };
}

async function loadConfig(argv: string[]): Promise<ProberConfig> {
	const index = argv.indexOf('--config');
	if (index === -1) return fromEnv();
	const path = argv[index + 1];
	if (!path) throw new Error('--config needs a file path.');
	const file = Bun.file(path);
	if (!(await file.exists())) throw new Error(`Prober config not found: ${path}`);
	const config = (await file.json()) as ProberConfig;
	if (!config.url || !config.token || !config.proberId || !Array.isArray(config.targets) || config.targets.length === 0)
		throw new Error(`${path} needs url, token, proberId and a non-empty targets array.`);
	return config;
}

async function probeHttp(config: TargetConfig): Promise<TargetReport> {
	const started = performance.now();
	const expected = config.expectStatus ?? [200, 201, 202, 203, 204, 205, 206, 207, 208, 226, 300, 301, 302, 303, 304, 305, 307, 308];
	try {
		const response = await fetch(config.target, {
			method: 'GET',
			redirect: 'manual',
			signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
		});
		const latencyMs = Math.round(performance.now() - started);
		return {
			target: config.target,
			kind: config.kind ?? 'https',
			status: expected.includes(response.status) ? 'up' : response.status >= 500 ? 'down' : 'degraded',
			statusCode: response.status,
			latencyMs,
			error: expected.includes(response.status) ? null : `unexpected status ${response.status}`,
			checkedAt: new Date().toISOString()
		};
	} catch (error) {
		return {
			target: config.target,
			kind: config.kind ?? 'https',
			status: 'down',
			statusCode: null,
			latencyMs: Math.round(performance.now() - started),
			error: (error as Error).message,
			checkedAt: new Date().toISOString()
		};
	}
}

async function probeTcp(config: TargetConfig): Promise<TargetReport> {
	const started = performance.now();
	const trimmed = config.target.replace(/^[a-z]+:\/\//, '');
	const separator = trimmed.lastIndexOf(':');
	const host = separator === -1 ? trimmed : trimmed.slice(0, separator);
	const port = separator === -1 ? 5432 : Number(trimmed.slice(separator + 1));
	return await new Promise<TargetReport>((resolve) => {
		const finish = (report: Omit<TargetReport, 'target' | 'kind' | 'statusCode' | 'checkedAt'> & { error: string | null }) =>
			resolve({
				target: config.target,
				kind: config.kind ?? 'tcp',
				statusCode: null,
				...report,
				checkedAt: new Date().toISOString()
			});
		const socket = connect({ host, port });
		socket.setTimeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		socket.once('connect', () => {
			socket.destroy();
			finish({ status: 'up', latencyMs: Math.round(performance.now() - started), error: null });
		});
		socket.once('timeout', () => {
			socket.destroy();
			finish({ status: 'down', latencyMs: Math.round(performance.now() - started), error: `timed out after ${config.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms` });
		});
		socket.once('error', (error) => {
			socket.destroy();
			finish({ status: 'down', latencyMs: Math.round(performance.now() - started), error: error.message });
		});
	});
}

async function probeDns(config: TargetConfig): Promise<TargetReport> {
	const started = performance.now();
	try {
		const answers = await dns.resolve(config.target.replace(/^[a-z]+:\/\//, '').split('/')[0]!);
		return {
			target: config.target,
			kind: 'dns',
			status: answers.length > 0 ? 'up' : 'down',
			statusCode: null,
			latencyMs: Math.round(performance.now() - started),
			error: answers.length > 0 ? null : 'no answers',
			checkedAt: new Date().toISOString()
		};
	} catch (error) {
		return {
			target: config.target,
			kind: 'dns',
			status: 'down',
			statusCode: null,
			latencyMs: Math.round(performance.now() - started),
			error: (error as Error).message,
			checkedAt: new Date().toISOString()
		};
	}
}

async function probe(config: TargetConfig): Promise<TargetReport> {
	const kind = config.kind ?? 'https';
	if (kind === 'http' || kind === 'https') return await probeHttp({ ...config, kind });
	if (kind === 'tcp' || kind === 'database') return await probeTcp(config);
	if (kind === 'dns') return await probeDns(config);
	return {
		target: config.target,
		kind: 'other',
		status: 'down',
		statusCode: null,
		latencyMs: null,
		error: `unsupported probe kind "${kind}"`,
		checkedAt: new Date().toISOString()
	};
}

async function post(config: ProberConfig, sequence: number, targets: TargetReport[]): Promise<void> {
	const endpoint = `${config.url.replace(/\/$/, '')}/api/v1/ha/prober/report`;
	const response = await fetch(endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
		body: JSON.stringify({ proberId: config.proberId, sequence, sentAt: new Date().toISOString(), installId: null, targets }),
		signal: AbortSignal.timeout(15_000)
	});
	if (response.ok) {
		const ack = (await response.json()) as { accepted?: number };
		console.log(`[prober] report #${sequence}: ${ack.accepted ?? 0}/${targets.length} accepted`);
		return;
	}
	const body = await response.text().catch(() => '');
	if (response.status === 404)
		console.error('[prober] the endpoint is absent: EXTERNAL_PROBER is off on the control plane.');
	else if (response.status === 401) console.error('[prober] token refused: re-register the prober.');
	else console.error(`[prober] report failed: ${response.status} ${body.slice(0, 300)}`);
}

async function main(): Promise<void> {
	const once = process.argv.includes('--once');
	const config = await loadConfig(process.argv.slice(2));
	const intervalSeconds = Math.max(10, Math.round(config.intervalSeconds ?? 60));
	// Time-based, so a restart does not replay a sequence the sink has already seen.
	let sequence = Math.floor(Date.now() / 1000);
	const report = async () => {
		sequence += 1;
		const targets = await Promise.all(config.targets.map((target) => probe(target)));
		await post(config, sequence, targets).catch((error: unknown) => console.error('[prober] post failed:', error));
	};
	await report();
	if (once) return;
	setInterval(() => void report(), intervalSeconds * 1_000);
	console.log(`[prober] ${config.proberId} probing ${config.targets.length} target(s) every ${intervalSeconds}s`);
}

await main();
