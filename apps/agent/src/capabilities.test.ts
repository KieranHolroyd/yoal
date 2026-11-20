import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENDPOINTS_GATEWAY_CAPABILITY, FUNCTIONS_PYTHON_CAPABILITY, INGRESS_SET_CAPABILITY, PROCESS_NODE_CAPABILITY, RELEASE_PHASE_CAPABILITY, nodeCapabilities } from '@yoal/contracts';
import { advertisedCapabilities } from './main.ts';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** `functions-python` follows the Pyodide cache on disk (D121). */
describe('advertisedCapabilities', () => {
	test('static capabilities only, until a Pyodide bundle is in the cache', () => {
		const dir = mkdtempSync(join(tmpdir(), 'yoal-pyodide-cap-'));
		dirs.push(dir);
		const noNode = join(dir, 'no-node');
		expect(advertisedCapabilities(join(dir, 'missing'), noNode, false)).toEqual([...nodeCapabilities, RELEASE_PHASE_CAPABILITY, INGRESS_SET_CAPABILITY]);
		writeFileSync(join(dir, 'yoal-eras.json'), '{}');
		expect(advertisedCapabilities(dir, noNode, false)).not.toContain(FUNCTIONS_PYTHON_CAPABILITY);
		writeFileSync(join(dir, 'pyodide_314.0.6_2026-08-17_8.capnp.bin'), 'bundle');
		expect(advertisedCapabilities(dir, noNode, false)).toEqual([...nodeCapabilities, RELEASE_PHASE_CAPABILITY, FUNCTIONS_PYTHON_CAPABILITY, INGRESS_SET_CAPABILITY]);
	});

	/** `process-node` follows the pinned Node.js on PATH (D125). */
	test('process-node only while the node binary exists', () => {
		const dir = mkdtempSync(join(tmpdir(), 'yoal-node-cap-'));
		dirs.push(dir);
		const binary = join(dir, 'node');
		expect(advertisedCapabilities(join(dir, 'missing'), binary, false)).not.toContain(PROCESS_NODE_CAPABILITY);
		writeFileSync(binary, '#!/bin/sh\n');
		expect(advertisedCapabilities(join(dir, 'missing'), binary, false)).toEqual([...nodeCapabilities, RELEASE_PHASE_CAPABILITY, PROCESS_NODE_CAPABILITY, INGRESS_SET_CAPABILITY]);
	});

	/** `endpoints-gateway` (HA-PLAN H24) needs openssl for the install-CA CSR. */
	test('endpoints-gateway only when the node can make a CSR', () => {
		const dir = mkdtempSync(join(tmpdir(), 'yoal-gw-cap-'));
		dirs.push(dir);
		const noNode = join(dir, 'no-node');
		expect(advertisedCapabilities(join(dir, 'missing'), noNode, false)).not.toContain(ENDPOINTS_GATEWAY_CAPABILITY);
		expect(advertisedCapabilities(join(dir, 'missing'), noNode, true)).toEqual([
			...nodeCapabilities,
			RELEASE_PHASE_CAPABILITY,
			ENDPOINTS_GATEWAY_CAPABILITY,
			INGRESS_SET_CAPABILITY,
		]);
		// The heartbeat schema caps the list at 32 entries.
		expect(advertisedCapabilities(join(dir, 'missing'), noNode, true).length).toBeLessThanOrEqual(32);
	});
});
