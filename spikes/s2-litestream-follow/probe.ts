/**
 * Follower-side lag probe. A read-only reader of the follower's file (the way a standby's
 * status page would read it) polls `s2_heartbeat` every S2_POLL_MS (default 50) and appends
 * `seq,ts_ms,seen_ms` for every newly visible heartbeat to S2_OUT. Lag = seen_ms - ts_ms; the
 * writer and the probe share one kernel clock (both are containers in one OrbStack VM).
 *
 * The last seen seq is kept in `${S2_OUT}.state`, so a restarted probe does not re-baseline:
 * rows applied while it was down are counted with their full lag. Read errors are logged as
 * `#err,<ms>,<code>` and the connection is reopened.
 */
import { Database } from 'bun:sqlite';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';

const path = process.env.S2_DB ?? '/data/yoal.db';
const out = process.env.S2_OUT ?? '/out/lag.csv';
const pollMs = Number(process.env.S2_POLL_MS ?? 50);
const stateFile = `${out}.state`;
let lastSeq = existsSync(stateFile) ? Number(readFileSync(stateFile, 'utf8')) : -1;
let db: Database | null = null;
let buf: string[] = [];
let lastFlush = Date.now();
let lastTick = 0;
let waitedForHeader = false;

function open(): Database | null {
	if (!existsSync(path)) return null;
	// A freshly restored file still carries the primary's WAL header (bytes 18-19 = 2) until the
	// first follow apply rewrites it to rollback mode. A WAL-mode reader holds a SHARED lock on the
	// file for as long as it is open, and Litestream's apply waits on F_SETLKW for an exclusive
	// lock, so opening now would stall follow indefinitely (seen in the first smoke run). Wait.
	const fd = openSync(path, 'r');
	const hdr = Buffer.alloc(2);
	readSync(fd, hdr, 0, 2, 18);
	closeSync(fd);
	if (hdr[0] !== 1) {
		if (!waitedForHeader) buf.push(`#wal-header,${Date.now()},${hdr[0]}`);
		waitedForHeader = true;
		return null;
	}
	const d = new Database(path, { readonly: true, strict: true });
	d.run('PRAGMA busy_timeout = 2000');
	return d;
}

while (true) {
	try {
		db ??= open();
		if (db) {
			if (lastSeq < 0) {
				const row = db.query('SELECT coalesce(max(seq), 0) AS n FROM s2_heartbeat').get() as { n: number };
				lastSeq = row.n;
				buf.push(`#baseline,${Date.now()},${lastSeq}`);
			} else {
				const rows = db.query('SELECT seq, ts_ms FROM s2_heartbeat WHERE seq > ? ORDER BY seq').all(lastSeq) as { seq: number; ts_ms: number }[];
				const seen = Date.now();
				for (const r of rows) buf.push(`${r.seq},${r.ts_ms},${seen}`);
				if (rows.length) lastSeq = rows[rows.length - 1]!.seq;
			}
		}
	} catch (err) {
		const code = (err as { code?: string }).code ?? (err as Error).message.slice(0, 60);
		if (!/no such table/.test(String(code)) && !/no such table/.test((err as Error).message)) buf.push(`#err,${Date.now()},${code}`);
		try {
			db?.close();
		} catch {}
		db = null;
	}
	const now = Date.now();
	if (now - lastTick >= 5000) {
		buf.push(`#tick,${now},${lastSeq}`);
		lastTick = now;
	}
	if (now - lastFlush >= 1000 && buf.length) {
		appendFileSync(out, buf.join('\n') + '\n');
		writeFileSync(stateFile, String(lastSeq));
		buf = [];
		lastFlush = now;
	}
	await Bun.sleep(pollMs);
}
