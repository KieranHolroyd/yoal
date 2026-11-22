import type { CloudShellSettings, CloudShellSettingsInput, CloudShellState } from '@yoal/contracts';
import { errorText, fetchJson } from '#lib/query.js';

/**
 * The cloud shell drawer (D236, docs/CLOUD-SHELL.md): one store for the header button, the
 * bottom drawer in the dashboard layout and the `/cloud-shell` page, so they agree on whether the
 * shell runs and the drawer is open.
 *
 * The drawer's open state and height are kept per browser. Reopening it after a reload never
 * starts a stopped shell on its own (that would undo the idle stop); only an explicit open does.
 */

const PREFS_KEY = 'yoal.cloud-shell.drawer';
export const DRAWER_MIN_HEIGHT = 200;
export const DRAWER_DEFAULT_HEIGHT = 380;
/** Where ContainerShell keeps the session it re-attaches to (its `storageKey('~cloud-shell')`). */
const TERMINAL_SESSION_KEY = 'yoal:container-shell:~cloud-shell';

interface DrawerPrefs {
	open: boolean;
	height: number;
}

export type CloudShellAction = 'start' | 'stop' | 'reset' | 'restart' | 'settings';

class CloudShellStore {
	/** The drawer is showing. */
	open = $state(false);
	/** Drawer height in CSS pixels, while not maximised. */
	height = $state(DRAWER_DEFAULT_HEIGHT);
	maximized = $state(false);
	/** The caller's shell, as `GET /api/v1/cloud-shell` last answered; null before the first read. */
	state = $state<CloudShellState | null>(null);
	/** Why the last read or action failed (a refusal, a network error). */
	failure = $state<string | null>(null);
	busy = $state<CloudShellAction | null>(null);
	/** Bumped after each start, so the terminal opens a new session in the new container. */
	generation = $state(0);

	#initialised = false;
	#poll: ReturnType<typeof setTimeout> | null = null;

	get shell() {
		return this.state?.shell ?? null;
	}

	get status() {
		return this.shell?.status ?? null;
	}

	get running() {
		return this.status === 'running';
	}

	get starting() {
		return this.status === 'starting' || this.busy === 'start';
	}

	/** Stopped because the last start failed; the message says why. */
	get failed() {
		return this.status === 'stopped' && Boolean(this.shell?.message);
	}

	/** Restore the drawer from this browser and read the shell's state once. */
	init(): void {
		if (this.#initialised) return;
		this.#initialised = true;
		try {
			const raw = localStorage.getItem(PREFS_KEY);
			if (raw) {
				const prefs = JSON.parse(raw) as Partial<DrawerPrefs>;
				if (typeof prefs.height === 'number' && prefs.height >= DRAWER_MIN_HEIGHT)
					this.height = prefs.height;
				this.open = prefs.open === true;
			}
		} catch {
			// Unreadable prefs: start closed at the default height.
		}
		void this.refresh();
	}

	#save(): void {
		try {
			localStorage.setItem(PREFS_KEY, JSON.stringify({ open: this.open, height: this.height }));
		} catch {
			// Private mode: the drawer still works for this page.
		}
	}

	/** Open the drawer; opening is the intent, so a stopped shell starts (not one that just failed). */
	async show(): Promise<void> {
		this.open = true;
		this.#save();
		await this.refresh();
		if (this.state?.enabled && (!this.shell || (this.status === 'stopped' && !this.failed)))
			await this.start();
	}

	hide(): void {
		this.open = false;
		this.maximized = false;
		this.#save();
	}

	toggle(): void {
		if (this.open) this.hide();
		else void this.show();
	}

	setHeight(height: number): void {
		this.height = Math.round(height);
		this.maximized = false;
		this.#save();
	}

	async refresh(): Promise<void> {
		try {
			this.state = await fetchJson<CloudShellState>('/api/v1/cloud-shell');
			this.failure = null;
		} catch (error) {
			this.failure = errorText(error);
		}
		this.#schedule();
	}

	/** Poll quickly while the node starts the container, slowly while it runs (the idle stop). */
	#schedule(): void {
		if (this.#poll) clearTimeout(this.#poll);
		this.#poll = null;
		const delay = this.status === 'starting' ? 2_000 : this.status === 'running' ? 60_000 : null;
		if (delay !== null) this.#poll = setTimeout(() => void this.refresh(), delay);
	}

	async #act(action: CloudShellAction): Promise<boolean> {
		this.busy = action;
		this.failure = null;
		try {
			await fetchJson(`/api/v1/cloud-shell/${action}`, {
				method: 'POST',
				fallback: `Could not ${action} the cloud shell.`
			});
			await this.refresh();
			return true;
		} catch (error) {
			this.failure = errorText(error);
			return false;
		} finally {
			this.busy = null;
		}
	}

	async start(): Promise<boolean> {
		const ok = await this.#act('start');
		if (ok) {
			// A session saved for re-attaching belongs to the old container: open a fresh one.
			try {
				sessionStorage.removeItem(TERMINAL_SESSION_KEY);
			} catch {
				// Private mode keeps nothing to forget.
			}
			this.generation += 1;
		}
		return ok;
	}

	stop(): Promise<boolean> {
		return this.#act('stop');
	}

	/** Stop and start again, so saved memory, CPU, idle-stop and disk settings apply now. */
	async restart(): Promise<boolean> {
		this.busy = 'restart';
		try {
			if (this.status === 'running' || this.status === 'starting') {
				await fetchJson('/api/v1/cloud-shell/stop', {
					method: 'POST',
					fallback: 'Could not stop the cloud shell.'
				});
			}
		} catch (error) {
			this.failure = errorText(error);
			this.busy = null;
			return false;
		}
		this.busy = null;
		return this.start();
	}

	/** Save some settings; the answer's `shell.pending` says what they wait for. */
	async saveSettings(input: CloudShellSettingsInput): Promise<CloudShellSettings> {
		this.busy = 'settings';
		try {
			const body = await fetchJson<{ settings: CloudShellSettings }>(
				'/api/v1/cloud-shell/settings',
				{
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(input),
					fallback: 'Could not save the cloud shell settings.'
				}
			);
			await this.refresh();
			return body.settings;
		} finally {
			this.busy = null;
		}
	}

	reset(): Promise<boolean> {
		return this.#act('reset');
	}
}

export const cloudShell = new CloudShellStore();

/** `1 GiB` or `512 MiB`. */
export function diskLabel(mb: number): string {
	return mb >= 1024 ? `${Math.round(mb / 1024)} GiB` : `${mb} MiB`;
}
