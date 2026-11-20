/**
 * The W3 object-store conformance suite against local emulators (HA-PLAN W3; lane E exit 1).
 *
 *   bun tests/object-store/conformance.e2e.ts [minio] [azurite] [gcs] [--keep] [--json <file>]
 *
 * Starts the pinned emulators (`tests/object-store/emulators.ts`) unless `up` already started
 * them, runs `runObjectStoreConformance` against each through the production backends, prints
 * every case and the numbers (conditional-write p50/p99, winners per generation under 200
 * contending writers), and removes the emulators it started unless `--keep`. Exits 1 on any
 * failure. Never touches a real cloud store.
 */
import { writeFileSync } from 'node:fs';
import { runObjectStoreConformance, type ConformanceReport, type ConformanceSubject } from '../../packages/core/src/object-store/conformance.ts';
import { readEmulatorState, startEmulators, stopEmulators, type EmulatorName } from './emulators.ts';
import { minioSubject } from './subjects/minio.ts';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const jsonIndex = args.indexOf('--json');
const jsonFile = jsonIndex >= 0 ? args[jsonIndex + 1] : undefined;
const all: EmulatorName[] = ['minio', 'azurite', 'gcs'];
const picked = all.filter((name) => args.includes(name));
const names = picked.length ? picked : all;
const writers = Number(process.env.YOAL_CONFORMANCE_WRITERS ?? 200);
const generations = Number(process.env.YOAL_CONFORMANCE_GENERATIONS ?? 5);

async function subjectFor(name: EmulatorName, endpoint: string): Promise<ConformanceSubject> {
	if (name === 'minio') return minioSubject(endpoint);
	if (name === 'azurite') return (await import('./subjects/azurite.ts')).azuriteSubject(endpoint);
	return (await import('./subjects/gcs.ts')).gcsSubject(endpoint);
}

const existing = readEmulatorState();
const toStart = names.filter((name) => !existing[name]);
const endpoints = toStart.length ? await startEmulators(toStart) : existing;
const reports: ConformanceReport[] = [];
try {
	for (const name of names) {
		const subject = await subjectFor(name, endpoints[name]!);
		console.log(`\n== ${subject.name} at ${endpoints[name]} ==`);
		reports.push(await runObjectStoreConformance(subject, { writers, generations, log: (line) => console.log(line) }));
	}
} finally {
	if (!keep && toStart.length) await stopEmulators(toStart);
}

console.log('\n== summary ==');
for (const report of reports) {
	const passed = report.cases.filter((c) => c.ok && !c.skipped).length;
	const skipped = report.cases.filter((c) => c.skipped).length;
	const failed = report.cases.filter((c) => !c.ok).length;
	const cw = report.metrics.conditionalWrites;
	const contention = report.metrics.contention;
	console.log(
		`${report.ok ? 'PASS' : 'FAIL'}  ${report.subject}: ${passed} passed, ${skipped} skipped, ${failed} failed; ` +
			`conditional writes n=${cw.count} p50=${cw.p50Ms} ms p99=${cw.p99Ms} ms max=${cw.maxMs} ms; ` +
			(contention
				? `${contention.writers} writers x ${contention.generations} generations, winners ${contention.winnersPerGeneration.join('/')}, losers ${JSON.stringify(contention.loserStatuses)}, throttled retries ${contention.throttledRetries}`
				: 'contention not measured'),
	);
}
if (jsonFile) writeFileSync(jsonFile, `${JSON.stringify(reports, null, 2)}\n`);
process.exit(reports.every((report) => report.ok) && reports.length === names.length ? 0 : 1);
