/**
 * Build a control-plane-sized SQLite database from the real `packages/db` migrations.
 *
 *   bun spikes/s2-litestream-follow/seed.ts <out.db> [auditRows=200000] [rowsPerTable=200]
 *
 * Every migration runs through `createDb` (the control plane's own opener and pragmas). Then
 * `audit_log` gets `auditRows` realistic rows and every other table gets `rowsPerTable` rows
 * generated from its declared column types (foreign keys off while seeding; a table whose CHECK
 * constraints reject generated values is reported and left empty). No production data is read.
 */
import { createDb } from '../../packages/db/src/index.ts';
import { existsSync, rmSync, statSync } from 'node:fs';

const out = process.argv[2];
if (!out) {
	console.error('usage: bun seed.ts <out.db> [auditRows] [rowsPerTable]');
	process.exit(2);
}
const auditRows = Number(process.argv[3] ?? 200_000);
const perTable = Number(process.argv[4] ?? 200);
for (const suffix of ['', '-wal', '-shm']) if (existsSync(out + suffix)) rmSync(out + suffix);

const { sqlite } = createDb({ path: out, migrate: true });
sqlite.run('PRAGMA foreign_keys = OFF');

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
const words = ['deploy', 'project', 'node', 'database', 'route', 'secret', 'volume', 'backup', 'domain', 'bucket'];
const text = (min: number, max: number) => {
	const len = min + Math.floor(rand() * (max - min));
	let s = '';
	while (s.length < len) s += pick(words) + ' ';
	return s.slice(0, len);
};

// --- audit_log: the table that dominates a real control plane's size --------------------------
const actions = ['project.deploy', 'workload.scale', 'secret.set', 'node.heartbeat.lost', 'database.backup', 'domain.add', 'apiKey.create', 'route.update'];
const actors = ['user', 'apiKey', 'mcp', 'system', 'agent'] as const;
const insertAudit = sqlite.prepare(
	`INSERT INTO audit_log (id, org_id, actor_type, actor_id, client_id, action, resource, resource_id, args_json, result, error, ip_hash, operation_id, created_at)
	 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const t0 = Date.now() - 90 * 86_400_000;
sqlite.transaction(() => {
	for (let i = 0; i < auditRows; i++) {
		const action = pick(actions);
		insertAudit.run(
			`aud_${i.toString(16).padStart(8, "0")}${hex(16)}`,
			`org_${hex(8)}`,
			pick(actors),
			`usr_${hex(12)}`,
			rand() < 0.2 ? `cli_${hex(10)}` : null,
			action,
			action.split('.')[0]!,
			`res_${hex(16)}`,
			JSON.stringify({ name: text(8, 24), replicas: Math.floor(rand() * 5), note: text(40, 220) }),
			rand() < 0.97 ? 'ok' : 'error',
			null,
			hex(32),
			rand() < 0.1 ? `op_${hex(12)}` : null,
			t0 + Math.floor((i / auditRows) * 90 * 86_400_000),
		);
	}
})();

// --- every other table: rows from declared types ----------------------------------------------
const tables = (sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
	.map((r) => r.name)
	.filter((n) => n !== 'audit_log' && n !== 'yoal_migrations');
let filled = 0;
const skipped: string[] = [];
for (const table of tables) {
	const cols = sqlite.query(`PRAGMA table_info("${table}")`).all() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[];
	const names = cols.map((c) => `"${c.name}"`).join(', ');
	// CHECK (col IN ('a','b')) lists from the table's own DDL, so enum columns get legal values.
	const ddl = (sqlite.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string }).sql;
	const enums = new Map<string, string[]>();
	for (const m of ddl.matchAll(/"?(\w+)"?\s+IN\s*\(([^)]*)\)/gi)) enums.set(m[1]!, [...m[2]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!));
	const stmt = sqlite.prepare(`INSERT INTO "${table}" (${names}) VALUES (${cols.map(() => '?').join(', ')})`);
	let ok = 0;
	try {
		sqlite.transaction(() => {
			for (let i = 0; i < perTable; i++) {
				const row = cols.map((c) => {
					const t = c.type.toUpperCase();
					const allowed = enums.get(c.name);
					if (allowed?.length) return pick(allowed);
					if (c.pk && t.includes('INT')) return i + 1;
					if (c.pk) return `${table.slice(0, 4)}_${i}_${hex(12)}`;
					if (t.includes('INT')) return /_at$|_ms$|time/i.test(c.name) ? t0 + Math.floor(rand() * 90 * 86_400_000) : Math.floor(rand() * 3);
					if (t.includes('REAL') || t.includes('NUM')) return rand() * 100;
					if (t.includes('BLOB')) return new Uint8Array(32).map(() => Math.floor(rand() * 256));
					if (/json/i.test(c.name)) return JSON.stringify({ k: text(5, 30) });
					return `${text(6, 60)}#${i}`;
				});
				stmt.run(...(row as never[]));
				ok++;
			}
		})();
		filled++;
	} catch (err) {
		skipped.push(`${table} (${(err as Error).message.split('\n')[0]})`);
	}
	void ok;
}

sqlite.run('PRAGMA wal_checkpoint(TRUNCATE)');
const count = (sqlite.query('SELECT count(*) AS n FROM audit_log').get() as { n: number }).n;
sqlite.close();
console.log(JSON.stringify({ out, bytes: statSync(out).size, tables: tables.length + 1, filled, skipped: skipped.length, auditRows: count }));
if (process.env.S2_VERBOSE) for (const s of skipped) console.error(`skipped ${s}`);
