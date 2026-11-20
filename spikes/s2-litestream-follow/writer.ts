/**
 * Primary workload: S2_RATE transactions per second (default 50) against S2_DB, opened with the
 * control plane's own pragmas (packages/db createDb: WAL, foreign_keys, busy_timeout 5000).
 * Each transaction inserts one audit_log row and one heartbeat row (seq, ts_ms); every fifth also
 * updates a `nodes` row, like an agent heartbeat. SIGTERM stops after the current transaction.
 * Prints `final <seq>` on a clean exit.
 */
import { Database } from 'bun:sqlite';

const path = process.env.S2_DB ?? '/data/yoal.db';
const rate = Number(process.env.S2_RATE ?? 50);
const db = new Database(path, { create: false, strict: true });
for (const p of ['journal_mode = WAL', 'foreign_keys = ON', 'busy_timeout = 5000']) db.run(`PRAGMA ${p}`);
db.run('CREATE TABLE IF NOT EXISTS s2_heartbeat (seq INTEGER PRIMARY KEY, ts_ms INTEGER NOT NULL)');

const nodeIds = (db.query('SELECT id FROM nodes LIMIT 50').all() as { id: string }[]).map((r) => r.id);
let seq = (db.query('SELECT coalesce(max(seq), 0) AS n FROM s2_heartbeat').get() as { n: number }).n;
const audit = db.prepare(
	`INSERT INTO audit_log (id, org_id, actor_type, actor_id, action, resource, resource_id, args_json, result, ip_hash, created_at)
	 VALUES (?, 'org_s2', 'agent', ?, 'node.heartbeat', 'node', ?, ?, 'ok', ?, ?)`,
);
const hb = db.prepare('INSERT INTO s2_heartbeat (seq, ts_ms) VALUES (?, ?)');
const touch = db.prepare('UPDATE nodes SET updated_at = ? WHERE id = ?');
const tx = db.transaction((n: number) => {
	const node = nodeIds[n % nodeIds.length]!;
	audit.run(`aud_s2_${n}_${Math.random().toString(36).slice(2, 10)}`, node, node, JSON.stringify({ seq: n, cpu: Math.random(), mem: Math.random() }), Bun.hash(String(n)).toString(16), Date.now());
	if (n % 5 === 0) touch.run(Date.now(), node);
	hb.run(n, Date.now());
});

let stop = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) (process as unknown as NodeJS.EventEmitter).on(sig, () => (stop = true));

const start = performance.now();
const startSeq = seq;
let lastReport = start;
console.log(`writer ${path} rate=${rate}/s from seq ${seq}`);
while (!stop) {
	seq++;
	tx.immediate(seq);
	const now = performance.now();
	if (now - lastReport >= 10_000) {
		console.log(`${new Date().toISOString()} seq=${seq} rate=${(((seq - startSeq) * 1000) / (now - start)).toFixed(1)}/s`);
		lastReport = now;
	}
	const due = start + ((seq - startSeq) * 1000) / rate;
	const wait = due - performance.now();
	if (wait > 0) await Bun.sleep(wait);
}
db.close();
console.log(`final ${seq}`);
