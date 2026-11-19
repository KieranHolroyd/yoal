/**
 * Debian 13 ships an AppArmor profile for crun (`/etc/apparmor.d/crun`, `flags=(unconfined)`). It
 * confines nothing, but it stacks onto every container: processes run as
 * `containers-default-<v>//&crun`, while Podman's generated `containers-default` profile only lets
 * a container receive signals from the bare `containers-default-<v>` label. Every signal between
 * two processes of the same container is then denied: Postgres cannot request a checkpoint or
 * stop its children, crash-loops and never finishes recovery.
 *
 * Disabling that one profile (the distro's own `disable/` symlink) removes the stacking; containers
 * keep the real `containers-default` confinement. Ubuntu is left alone: there the crun profile
 * grants the user-namespace permission Ubuntu restricts for unconfined binaries.
 */
export function shouldDisableCrunProfile(input: { osId: string; profile: string | null; disabled: boolean }): boolean {
	if (input.osId !== 'debian' || input.disabled || input.profile === null) return false;
	// Only the stock "allows everything" profile; a site-written confining profile is the operator's.
	return /profile\s+crun\s+\S+\s+flags=\(unconfined\)/.test(input.profile);
}
