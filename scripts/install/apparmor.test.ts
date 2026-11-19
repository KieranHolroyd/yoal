import { describe, expect, test } from 'bun:test';
import { shouldDisableCrunProfile } from './apparmor.ts';

const STOCK = `abi <abi/4.0>,
include <tunables/global>

profile crun /usr/bin/crun flags=(unconfined) {
  userns,
  include if exists <local/crun>
}
`;

describe('shouldDisableCrunProfile', () => {
	test('disables the stock unconfined crun profile on Debian', () => {
		expect(shouldDisableCrunProfile({ osId: 'debian', profile: STOCK, disabled: false })).toBe(true);
	});

	test('leaves Ubuntu, a disabled profile, a missing one and a confining one alone', () => {
		expect(shouldDisableCrunProfile({ osId: 'ubuntu', profile: STOCK, disabled: false })).toBe(false);
		expect(shouldDisableCrunProfile({ osId: 'debian', profile: STOCK, disabled: true })).toBe(false);
		expect(shouldDisableCrunProfile({ osId: 'debian', profile: null, disabled: false })).toBe(false);
		expect(
			shouldDisableCrunProfile({ osId: 'debian', profile: 'profile crun /usr/bin/crun {\n  deny network,\n}\n', disabled: false }),
		).toBe(false);
	});
});
