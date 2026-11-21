#!/usr/bin/env bun
/**
 * HA lab only, run as root on lab-a by the scenarios: the platform's release-command runs for one
 * project (HA-PLAN H25, I16), read **read-only** from the control plane's SQLite
 * (`release_command_runs`, migration 0119). No REST route lists these runs yet
 * (`ReleaseCommandScheduler.list` in packages/core/src/release-commands.ts has no route), so the
 * lab reads the table the scheduler owns; it never writes.
 *
 *   bun release-runs.ts --project <slug> [--since <epoch ms>]
 *
 * Prints `{ runs: [{ id, releaseId, attempt, status, nodeName, createdAt, startedAt, finishedAt,
 * exitCode }] }`, oldest first.
 */
import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

/** The runs for `project` created at or after `since`, with the node's fleet name. */
export function releaseRuns(db: Database, project: string, since: number): unknown[] {
	return db
		.query(
			`SELECT r.id, r.release_id AS releaseId, r.attempt, r.status, n.name AS nodeName, r.created_at AS createdAt,
			        r.started_at AS startedAt, r.finished_at AS finishedAt, r.exit_code AS exitCode
			 FROM release_command_runs r
			 JOIN projects p ON p.id = r.project_id
			 LEFT JOIN nodes n ON n.id = r.node_id
			 WHERE p.slug = ? AND r.created_at >= ?
			 ORDER BY r.created_at, r.attempt`,
		)
		.all(project, since);
}

if (import.meta.main) {
	const { values: flags } = parseArgs({ options: { project: { type: 'string' }, since: { type: 'string', default: '0' } } });
	if (!flags.project) throw new Error('--project is required');
	const dataDir = /^YOAL_DATA_DIR=["']?([^"'\n]+)["']?$/m.exec(readFileSync('/etc/yoal/yoal.env', 'utf8'))?.[1] ?? '/var/lib/yoal/data';
	const path = existsSync(`${dataDir}/yoal.db`) ? `${dataDir}/yoal.db` : `${dataDir}/skiff.db`;
	const db = new Database(path, { readonly: true });
	const runs = releaseRuns(db, flags.project, Number(flags.since));
	db.close();
	console.log(JSON.stringify({ runs }));
}
