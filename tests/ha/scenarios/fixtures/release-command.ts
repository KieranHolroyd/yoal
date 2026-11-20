#!/usr/bin/env bun
/**
 * The release command rolling-deploy-under-load gives the checker app (HA-PLAN H25: run once per
 * release, on one node, with the app's environment, before the first copy rolls). Shipped into the
 * release directory next to the checker app; never part of the checker app itself.
 *
 *   release: { command: ["bun", "release-command.ts"], timeoutSeconds: 120 }
 *
 * It records one singleton start for job `release:<release>` through the app's public route, which
 * is how the checker's I16 counts release-command runs (tests/ha/README.md), then:
 *   - exits 1 if the release ships a `release-fail` file (the "failing release command" check);
 *   - sleeps `release-sleep-s` seconds if that file exists (to hold the run open under a partition).
 *
 * The release id is the scenario's marker (`release-marker.txt`), so the scenario knows which job to
 * count; the platform's own id (YOAL_RELEASE_ID, if W5 provides one) is recorded beside it.
 * Env: CHECKER_URL (the platform's public address) and CHECKER_HOST (the app's Host), set by the
 * scenario on the workload.
 */
import { existsSync, readFileSync } from 'node:fs';

const release = existsSync('release-marker.txt') ? readFileSync('release-marker.txt', 'utf8').trim() : (process.env.YOAL_RELEASE_ID ?? 'unknown');
const base = process.env.CHECKER_URL;
if (!base) {
	console.error('release-command: CHECKER_URL is not set');
	process.exit(2);
}
const url = `${base}/singleton?job=${encodeURIComponent(`release:${release}`)}&run=${encodeURIComponent(release)}`;
let recorded = false;
for (let attempt = 0; attempt < 10 && !recorded; attempt++) {
	try {
		const response = await fetch(url, { headers: process.env.CHECKER_HOST ? { host: process.env.CHECKER_HOST } : {}, signal: AbortSignal.timeout(5000) });
		recorded = response.ok;
	} catch {
		await Bun.sleep(1000);
	}
}
console.log(`release-command: release ${release} (platform id ${process.env.YOAL_RELEASE_ID ?? 'none'}) recorded=${recorded}`);
if (existsSync('release-sleep-s')) await Bun.sleep(Number(readFileSync('release-sleep-s', 'utf8').trim()) * 1000);
if (existsSync('release-fail')) {
	console.error('release-command: failing on purpose (release-fail)');
	process.exit(1);
}
process.exit(recorded ? 0 : 1);
