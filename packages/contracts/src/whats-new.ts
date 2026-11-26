import { compareSemver, parseSemver } from './semver.ts';

/**
 * Post-update onboarding (docs/WHATS-NEW.md, D212).
 *
 * Every release may carry a small set of changes a platform admin should see after updating. The
 * catalog below ships with the release, so it cannot drift from the code: an item is only visible
 * while the running version is at or past its `since` release.
 *
 * Two kinds of item exist:
 *
 * - `info`: something new the admin should know about. Acknowledging it is enough.
 * - `consent`: a change that needs an explicit decision before it applies (for example the opt-in
 *   anonymous usage ping). The server resolves the setting's current state; the dashboard never
 *   pretends a consent item is done until the admin chooses.
 *
 * The version the admin last reviewed is stored server-side under one install-wide key, because
 * only platform admins see this flow and consent belongs to the install, not to one person.
 */

/**
 * The release before the first tracked release. An install that predates this feature has no
 * stored version, so it starts here and sees every item from the release that introduced the
 * ledger onwards. A fresh install records the running version at setup completion and starts
 * empty (see `WhatsNewService.markInstalled`).
 */
export const WHATS_NEW_BASELINE_VERSION = '0.13.5';

export type WhatsNewAttention = 'info' | 'consent';

/** A decision is final for the item; only `enabled` turns a consent setting on. */
export type WhatsNewDecision = 'acknowledged' | 'enabled' | 'declined';

/** Settings the server knows how to read and change for a consent item. */
export type WhatsNewConsent = 'usage-analytics';

export interface WhatsNewItem {
	/** Stable id; never reuse one for a different change. */
	id: string;
	/**
	 * The release that first included this change. The item is shown to an install whose last
	 * reviewed version is older than this and whose running version is at least this. Authors set
	 * it to the release that carries the entry (see docs/WHATS-NEW.md).
	 */
	since: string;
	title: string;
	summary: string;
	/** A short explanation; plain text, one or two paragraphs. */
	body?: string;
	attention: WhatsNewAttention;
	/** Which setting the consent item reads and writes. Required when attention is `consent`. */
	consent?: WhatsNewConsent;
	/** Button labels for a consent item; the page falls back to generic wording. */
	consentLabels?: { enable: string; decline: string; keep: string };
	/** Where to read the setting or feature in the dashboard. */
	href?: string;
	/** Public documentation for the change. */
	learnMore?: string;
}

export const WHATS_NEW_ITEMS: readonly WhatsNewItem[] = [
	{
		id: 'usage-analytics',
		since: '0.13.6',
		title: 'Anonymous usage analytics is now available',
		summary:
			'Yoal can send one small anonymous ping a day so the project can see which parts of the platform are used. It is off until you decide.',
		body: 'The ping contains counts (projects, deployments, nodes, databases, users), the release, the OS and architecture, the feature flags that are on and the optional services that are configured. It never contains a hostname, address, organisation, user or project name, and there is no free-form field. You can see the exact payload in Settings before enabling it, pin a different collector, or turn it off at any time.',
		attention: 'consent',
		consent: 'usage-analytics',
		consentLabels: {
			enable: 'Enable anonymous analytics',
			decline: 'Keep it off',
			keep: 'Keep it on'
		},
		href: '/settings/usage-analytics',
		learnMore: 'https://github.com/yoal-dev/yoal/blob/main/docs/USAGE-ANALYTICS.md'
	},
	{
		id: 'cloud-shell',
		since: '0.16.13',
		title: 'Cloud shell: a terminal on your servers with the CLI signed in',
		summary:
			'Infrastructure → Cloud shell opens a terminal in a small container on one of your nodes, with the yoal CLI already signed in and a 1 GiB home disk that keeps your files.',
		body: 'Each person gets their own shell. It runs with the same sandbox as an app container, stops after 20 minutes without typing (the disk stays), and the CLI key it holds expires with it. Deployers and up can use it (cloudShell:use); the CLI is signed in only for roles that may create access keys. The dashboard assistant can run commands in your shell too, each one only after you confirm it. Nodes need this release before a shell can run on them. Turn it off with YOAL_FEATURE_CLOUD_SHELL=0.',
		attention: 'info',
		href: '/cloud-shell',
		learnMore: 'https://github.com/yoal-dev/yoal/blob/main/docs/CLOUD-SHELL.md'
	},
	{
		id: 'overlay-mesh',
		since: '0.16.16',
		title: 'Mesh mode: direct private paths between nodes, through NAT',
		summary:
			'Settings → Clustering → Overlay network can now connect every pair of nodes directly, as Tailscale does, instead of relaying pairs behind NAT through an ingress hub.',
		body: 'Off by default. When it is on, the control plane reads the public address each node is seen on from the hubs and lets each pair dial the other. A pair switches to the direct path only after a handshake proves it works, and falls back to the hub if it stops answering, so turning it on interrupts nothing. Each node also gets a <node>.yoal.internal name in its hosts file. Nodes need this release before they take part; nodes on older agents stay on the hubs.',
		attention: 'info',
		href: '/settings/clustering',
		learnMore: 'https://github.com/yoal-dev/yoal/blob/main/docs/CLUSTERING.md'
	},
	{
		id: 'database-public-access',
		since: '0.16.18',
		title: 'Public access: use a database from outside Yoal',
		summary:
			'A database can now be reached from a laptop, CI or an app hosted elsewhere at <name>-<org>.db.<your domain>:<port>, through a TLS proxy on your ingress nodes that only lets in the addresses you list.',
		body: 'Off for every database until an owner or admin turns it on (database:expose, with step-up). You list the CIDRs your app connects from; private, loopback and very broad ranges are refused, and any-address access needs YOAL_FEATURE_DB_PUBLIC_ANYWHERE. TLS is required with a publicly trusted certificate, Postgres logins are limited to the credentials you pick, repeated failed logins ban the address, and access can expire by itself. PostgreSQL, Valkey, Redis, MongoDB and ClickHouse are supported; MySQL and MariaDB are not yet. Operators add a DNS-only *.db.<content domain> record pointing at the ingress nodes, and ingress nodes need this release. Turn it off everywhere with YOAL_FEATURE_DB_PUBLIC_ACCESS=0.',
		attention: 'info',
		href: '/databases',
		learnMore: 'https://github.com/yoal-dev/yoal/blob/main/docs/DATABASES.md'
	}
];

export function whatsNewItem(id: string): WhatsNewItem | undefined {
	return WHATS_NEW_ITEMS.find((item) => item.id === id);
}

/** The live state of a consent setting, so the page shows the truth rather than the item's copy. */
export interface WhatsNewConsentState {
	/** What the setting is called, for a generic “<label> is on/off” line. */
	label: string;
	enabled: boolean;
	/** The collector or destination currently in use; shown so the admin knows where data goes. */
	endpoint: string;
}

export interface WhatsNewItemView extends WhatsNewItem {
	decision: WhatsNewDecision | null;
	decidedAt: string | null;
	/** Present only for `consent` items. */
	consentState: WhatsNewConsentState | null;
}

export interface WhatsNewView {
	currentVersion: string;
	lastSeenVersion: string;
	/** Items in `(lastSeenVersion, currentVersion]`, newest release first. */
	items: WhatsNewItemView[];
	/**
	 * Catalog items already reviewed (`since <= lastSeenVersion`, never newer than the running
	 * release), newest first. Read-only history, so the page stays useful once caught up.
	 */
	earlier: WhatsNewItem[];
	/** Items with no decision yet. */
	pending: number;
	/** Pending consent items, which cannot be dismissed as read. */
	attention: number;
	/** Whether this principal may record decisions (a platform viewer sees them read-only). */
	canDecide: boolean;
}

/**
 * Catalog items in `(lastSeen, current]`, newest release first. A bad version string is treated
 * as unknown: nothing is shown rather than guessing at the install's history.
 */
export function whatsNewItemsBetween(
	items: readonly WhatsNewItem[],
	lastSeen: string,
	current: string
): WhatsNewItem[] {
	const to = parseSemver(current);
	if (!to) return [];
	const from = parseSemver(lastSeen);
	if (from && compareSemver(from, to) >= 0) return [];
	return items
		.filter((item) => {
			const since = parseSemver(item.since);
			if (!since || compareSemver(since, to) > 0) return false;
			return from ? compareSemver(since, from) > 0 : true;
		})
		.sort((a, b) => compareSemver(b.since, a.since));
}

/**
 * Catalog items at or below `version`, newest release first: the history an install has already
 * reviewed. A bad version string yields nothing.
 */
export function whatsNewItemsThrough(
	items: readonly WhatsNewItem[],
	version: string
): WhatsNewItem[] {
	const to = parseSemver(version);
	if (!to) return [];
	return items
		.filter((item) => {
			const since = parseSemver(item.since);
			return since !== null && compareSemver(since, to) <= 0;
		})
		.sort((a, b) => compareSemver(b.since, a.since));
}
