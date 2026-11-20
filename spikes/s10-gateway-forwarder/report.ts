/**
 * Summarise an S10 output directory against the pass criteria.
 *
 *   bun report.ts <out dir>
 */
import { existsSync, readFileSync } from 'node:fs';

const dir = process.argv[2]!;
const lines = (name: string) =>
	existsSync(`${dir}/${name}`)
		? readFileSync(`${dir}/${name}`, 'utf8').split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l))
		: [];

console.log('## (a) reachability');
for (const row of lines('reach.jsonl')) console.log(`  ${row.probe.padEnd(58)} ${row.result}`);

console.log('\n## (b) 100,000 short connections per target, during normal reloads');
for (const row of lines('short.jsonl')) {
	const bad = Object.entries(row.counts).filter(([k, v]) => k !== 'ok' && (v as number) > 0);
	console.log(`  ${row.target.padEnd(11)} ok=${row.counts.ok} failures=${JSON.stringify(Object.fromEntries(bad))} ${row.seconds}s p50=${row.ms.p50}ms p99=${row.ms.p99}ms  ${bad.length === 0 ? 'PASS' : 'FAIL'}`);
}

console.log('\n## (b) latency, sequential, interleaved (ms)');
const latency = lines('latency.jsonl');
const direct = latency.find((r) => r.target === 'direct');
for (const row of latency) {
	const addQ = direct ? (row.query.p99 - direct.query.p99).toFixed(3) : '?';
	const addC = direct ? (row.shortConnection.p99 - direct.shortConnection.p99).toFixed(3) : '?';
	const pass = Number(addQ) <= 2 && Number(addC) <= 2;
	console.log(
		`  ${row.target.padEnd(11)} query p50=${row.query.p50} p99=${row.query.p99} (+${addQ})  connect+query p50=${row.shortConnection.p50} p99=${row.shortConnection.p99} (+${addC})  ${row.target === 'direct' ? 'baseline' : pass ? 'PASS' : 'FAIL'}`,
	);
}

console.log('\n## (b)(c) RSS and fds (samples every 60 s)');
const samples = lines('samples.jsonl');
for (const unit of ['yoal-w0-fwd-asis', 'yoal-w0-fwd-fix', 'yoal-w0-caddy']) {
	const series = samples.map((s) => s[unit]).filter((v) => v && v.rssKb > 0);
	if (series.length === 0) continue;
	const rss = series.map((v) => v.rssKb / 1024);
	const fds = series.map((v) => v.fds);
	const half = Math.floor(fds.length / 2);
	const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
	console.log(
		`  ${unit.padEnd(17)} n=${series.length} RSS MB first=${rss[0]!.toFixed(1)} last=${rss.at(-1)!.toFixed(1)} max=${Math.max(...rss).toFixed(1)}  fds first=${fds[0]} last=${fds.at(-1)} min=${Math.min(...fds)} max=${Math.max(...fds)} mean 1st half=${avg(fds.slice(0, half)).toFixed(1)} 2nd half=${avg(fds.slice(half)).toFixed(1)}`,
	);
}

console.log('\n## (c) soak');
const soak = lines('soak.jsonl');
const final = soak.find((r) => r.test === 'soak');
const rows = soak.filter((r) => r.at);
if (rows.length > 0) console.log(`  ${rows.length} checks from ${rows[0].at} to ${rows.at(-1).at}`);
if (final)
	for (const [name, t] of Object.entries(final.targets) as Array<[string, { short: Record<string, number>; idleLost: number; idleChecks: number }]>) {
		const bad = Object.entries(t.short).filter(([k, v]) => k !== 'ok' && v > 0);
		console.log(`  ${name.padEnd(11)} short ok=${t.short.ok} failures=${JSON.stringify(Object.fromEntries(bad))} idle lost=${t.idleLost}/${t.idleChecks} checks`);
	}
else if (rows.length > 0) {
	const sum: Record<string, { lost: number; bad: number; ok: number }> = {};
	for (const row of rows)
		for (const [name, v] of Object.entries(row)) {
			if (name === 'at') continue;
			const s = (sum[name] ??= { lost: 0, bad: 0, ok: 0 });
			const value = v as { idleLost: number; short: Record<string, number> };
			s.lost += value.idleLost;
			s.ok += value.short.ok;
			s.bad += Object.entries(value.short).filter(([k]) => k !== 'ok').reduce((a, [, n]) => a + n, 0);
		}
	for (const [name, s] of Object.entries(sum)) console.log(`  ${name.padEnd(11)} (running) short ok=${s.ok} failures=${s.bad} idle lost=${s.lost}`);
}

for (const name of ['lifecycle.log', 'rootless.log', 'reboot.log']) {
	if (!existsSync(`${dir}/${name}`)) continue;
	console.log(`\n## (d) ${name}`);
	console.log(readFileSync(`${dir}/${name}`, 'utf8').trim().replace(/^/gm, '  '));
}
