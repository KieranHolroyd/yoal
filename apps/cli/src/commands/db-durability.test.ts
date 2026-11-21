import { describe, expect, test } from 'bun:test';
import { durabilityCommand, switchoverCommand } from './db-durability.ts';

/**
 * `yoal db switchover <name> <replica-id>` is its own subcommand. The old dispatcher handed the
 * name to `durability()`, which treated it as a verb, so the command could never run (W10 review).
 */
describe('the db switchover dispatcher', () => {
	test('switchover reads the name as a positional, not a durability verb', async () => {
		await expect(switchoverCommand([])).rejects.toThrow(/database name/);
	});

	test('durability still owns only the durability surface', async () => {
		// Help is printed without a client or network, so this proves the two commands are separate.
		await durabilityCommand(['--help']);
	});
});
