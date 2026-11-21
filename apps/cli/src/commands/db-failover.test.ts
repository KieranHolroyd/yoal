import { describe, expect, test } from 'bun:test';
import { failoverCommand, failoverUsage } from './db-failover.ts';

describe('the db failover dispatcher', () => {
	test('names the database and shows the policy surface', async () => {
		await expect(failoverCommand([])).rejects.toThrow(/database name/);
	});

	test('refuses more than one verb', async () => {
		await expect(failoverCommand(['main', '--arm', '--disarm'])).rejects.toThrow(/Choose one/);
	});

	test('prints its usage', async () => {
		const original = console.log;
		const lines: string[] = [];
		console.log = (value: unknown) => lines.push(String(value));
		try {
			await failoverCommand(['--help']);
		} finally {
			console.log = original;
		}
		expect(lines.join('\n')).toBe(failoverUsage);
	});
});
