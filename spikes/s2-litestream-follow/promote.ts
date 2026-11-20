/**
 * Promote a follower's file in place: open it read-write the way createDb does (WAL,
 * foreign_keys, busy_timeout), run `PRAGMA integrity_check`, and report the last heartbeat.
 *   bun /rig/promote.ts <db>
 */
import { Database } from 'bun:sqlite';

const path = process.argv[2]!;
const t0 = performance.now();
const db = new Database(path, { create: false, strict: true });
const before = (db.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
for (const p of ['journal_mode = WAL', 'foreign_keys = ON', 'busy_timeout = 5000']) db.run(`PRAGMA ${p}`);
const integrity = (db.query('PRAGMA integrity_check').all() as { integrity_check: string }[]).map((r) => r.integrity_check);
const fk = db.query('PRAGMA foreign_key_check').all().length;
const maxSeq = (db.query('SELECT coalesce(max(seq), 0) AS n FROM s2_heartbeat').get() as { n: number }).n;
const after = (db.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
db.close();
console.log(JSON.stringify({ path, journalBefore: before, journalAfter: after, integrity: integrity.join(';'), fkViolations: fk, maxSeq, ms: Math.round(performance.now() - t0) }));
