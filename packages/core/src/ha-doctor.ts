import { randomUUID } from 'node:crypto';
import {
	DATABASE_REPLICAS_CAPABILITY,
	DB_MEMBER_CAPABILITY,
	DB_MEMBER_SELF_FENCING_CAPABILITY,
	ENDPOINTS_GATEWAY_CAPABILITY,
	FEATURE_FLAG_NAMES,
	HA_EPOCH_CAPABILITY,
	INGRESS_SET_CAPABILITY,
	OBJECT_STORE_KINDS_CAPABILITY,
	PITR_REWIND_CAPABILITY,
	RELEASE_PHASE_CAPABILITY,
	featureEnvKey,
	featureFlagDrift,
	haCheckIds,
	haDependentChecks,
	haInitPlan,
	summarizeHaChecks,
	type FeatureName,
	type HaCheck,
	type HaCheckId,
	type HaCertificateSource,
	type HaDependent,
	type HaInitAnswers,
	type HaPreflightReport,
	type HaProfile,
	type NodeRole,
	type Principal,
	type SteeringDriverKind,
} from '@yoal/contracts';
import { nodes as nodesTable } from '@yoal/db';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { CoreError } from './errors.ts';
import { DEFAULT_CONTROL_LEASE_POLICY } from './ha-lease.ts';
import { isConditionalStore } from './ha-control-arbiter.ts';
import { haFindingChecks, haFindings } from './ha-preflight.ts';
import { probeConditionalWrites, type ConditionalWriteSupport } from './object-store/probe.ts';
import { rolesFor } from './nodes.ts';
import { parseJson } from './util.ts';

/** Check ids the W12 findings already cover. */
const W12_CHECKS: ReadonlySet<HaCheckId> = new Set(['platform-store', 'registry-storage', 'identity', 'mail', 'telemetry-spool']);
/** Check ids built by another lane: lane A owns `regions` (the foundation's REGIONS-off warning stays here). */
const OTHER_LANE_CHECKS: ReadonlySet<HaCheckId> = new Set(['regions']);

const TITLES: Readonly<Record<HaCheckId, string>> = {
	nodes: 'Nodes and roles',
	'node-capabilities': 'Agent capabilities',
	zones: 'Zones',
	regions: 'Regions',
	clocks: 'Clocks',
	'overlay-links': 'Overlay links',
	'arbiter-conditional-writes': 'Arbiter conditional writes',
	certificates: 'Certificates',
	steering: 'Steering',
	backups: 'Backups',
	headroom: 'Headroom',
	'platform-store': 'Platform object store',
	'registry-storage': 'Registry storage',
	identity: 'Identity',
	mail: 'Mail',
	'telemetry-spool': 'Telemetry spool',
	'flags-consistent': 'Control-plane hosts run the same flags',
	'ha-dependents': 'Nothing depends on an HA feature',
};

const NOT_REQUIRED = 'Not required by the single profile.';

/** Control-plane roles that mean a standby is enrolled. */
const STANDBY_ROLES = ['joining', 'standby', 'standby-behind', 'promoting'];

/** The lease's tolerated clock difference (W9): beyond it a node's view of a lease is wrong. */
export const CLOCK_SKEW_FAIL_MS = DEFAULT_CONTROL_LEASE_POLICY.skewToleranceMs;
/** Half the tolerance: worth fixing before it matters. Heartbeat transit is in the number. */
export const CLOCK_SKEW_WARN_MS = Math.floor(CLOCK_SKEW_FAIL_MS / 2);
/** A clock sample older than this is not evidence (a node that stopped heartbeating). */
const CLOCK_SAMPLE_MAX_AGE_MS = 5 * 60_000;
/** WireGuard re-handshakes at least every 2 min on a live link; older than 3 min is down. */
export const OVERLAY_HANDSHAKE_MAX_AGE_MS = 180_000;
/** A WireGuard report older than this is stale evidence. */
const OVERLAY_REPORT_MAX_AGE_MS = 5 * 60_000;
/** A backup older than this does not count as a recent off-node copy. */
export const BACKUP_MAX_AGE_MS = 48 * 3_600_000;
/** An arbiter probe result is reused for this long, so a dashboard poll does not write every second. */
const ARBITER_PROBE_TTL_MS = 60_000;
/** Doctor: data-disk use that warns, and that fails. */
export const DISK_WARN_PERCENT = 85;
export const DISK_FAIL_PERCENT = 95;

/** Which agent capability each profile flag needs, and on which nodes (HA-PLAN §9, CLUSTERING §13.7). */
const FLAG_CAPABILITIES: ReadonlyArray<{ flag: FeatureName; capability: string; roles: readonly NodeRole[] | 'all' }> = [
	{ flag: 'ENDPOINTS_GATEWAY', capability: ENDPOINTS_GATEWAY_CAPABILITY, roles: ['compute', 'data'] },
	{ flag: 'RELEASE_PHASE', capability: RELEASE_PHASE_CAPABILITY, roles: ['compute'] },
	{ flag: 'INGRESS_SET', capability: INGRESS_SET_CAPABILITY, roles: ['ingress'] },
	{ flag: 'CONTROL_STANDBY', capability: HA_EPOCH_CAPABILITY, roles: 'all' },
	{ flag: 'SYNC_REPLICA', capability: DATABASE_REPLICAS_CAPABILITY, roles: ['data'] },
	{ flag: 'SYNC_REPLICA', capability: DB_MEMBER_CAPABILITY, roles: ['data'] },
	{ flag: 'PITR_REWIND', capability: PITR_REWIND_CAPABILITY, roles: ['data'] },
];

type NodeRow = typeof nodesTable.$inferSelect;

interface NodeFact {
	id: string;
	name: string;
	status: string;
	online: boolean;
	roles: NodeRole[];
	zone: string;
	capabilities: string[];
	row: NodeRow;
}

interface ArbiterProbe {
	support: ConditionalWriteSupport | 'none';
	detail: string | null;
	kind: string;
	at: number;
}

export interface HaPreflightOptions {
	/** The `ha init` answers the checks should assume (steering driver, certificate source). */
	answers?: HaInitAnswers;
}

const subject = (kind: NonNullable<HaCheck['subject']>['kind'], id: string, name: string): HaCheck['subject'] => ({ kind, id, name });
const pass = (id: HaCheckId, title: string, evidence: string[], about: HaCheck['subject'] = null): HaCheck => ({
	id,
	title,
	status: 'pass',
	evidence,
	fix: null,
	subject: about,
});
const skip = (id: HaCheckId, title: string, evidence: string[], about: HaCheck['subject'] = null): HaCheck => ({
	id,
	title,
	status: 'skip',
	evidence,
	fix: null,
	subject: about,
});
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;
const editNode = (node: { id: string; name: string }, field: string, value: string) =>
	`Nodes → ${node.name} → Edit node → ${field} (PATCH /api/v1/nodes/${node.id} {"${field.toLowerCase()}": ${value}})`;

/**
 * `yoal ha preflight` and `yoal doctor` (HA-PLAN H27, W14). Wave 5 lane B; lane A builds the
 * `regions` check.
 *
 * `preflight` returns every check id in the `HaCheck` shape, each from real state:
 * - nodes, roles, zones and capabilities from the `nodes` rows the heartbeats keep;
 * - clocks from each heartbeat's `x-yoal-agent-time` (`recordClock`), held in memory: a fresh
 *   control plane knows every clock again after one heartbeat round;
 * - overlay links from each node's last WireGuard report (handshake age per peer);
 * - the arbiter from the W3 conditional-write probe against the platform store (`probeArbiter`,
 *   async, cached for a minute: the REST route and `ha init` probe before they read the report);
 * - certificates from the W7 fingerprints the ingress nodes report;
 * - steering from the selected (or answered) driver's own preflight;
 * - backups from each database's last backup and its target, or PITR;
 * - headroom from the scheduler's capacity snapshot (lose the largest node, then the largest zone);
 * - the W12 findings, `flags-consistent` and `ha-dependents`, as the foundation built them.
 * A check that cannot be computed is `skip` with the reason, never `pass`.
 *
 * `doctor` checks the running install against its own profile, plus single-node health: each
 * node's heartbeat, applied Caddy config and desired-state drift (`nodes`), its agent version
 * (`node-capabilities`) and its data disk (`headroom`), one entry per node. On the `single`
 * profile the checks only an HA fleet needs are `skip`. A doctor report is `ok` only when nothing
 * fails at all (a preflight's `ok` is the profile's required checks).
 */
export class HaDoctorService {
	#arbiter: ArbiterProbe | null = null;
	#clocks = new Map<string, { skewMs: number; at: number }>();

	constructor(private readonly ctx: CoreContext) {}

	preflight(principal: Principal, profile?: HaProfile, options: HaPreflightOptions = {}): HaPreflightReport {
		this.#assert(principal);
		const target = profile ?? this.ctx.cluster.get().ha.profile;
		const checks = this.#checks(target, 'preflight', options.answers ?? {});
		const { ok, counts } = summarizeHaChecks(target, checks);
		return { profile: target, mode: 'preflight', ok, counts, checks, generatedAt: new Date(this.ctx.now()).toISOString() };
	}

	doctor(principal: Principal): HaPreflightReport {
		this.#assert(principal);
		const target = this.ctx.cluster.get().ha.profile;
		const health = this.#nodeHealth();
		const covered = new Set(health.map((check) => check.id));
		// The per-node entries replace a "not required by the single profile" skip of the same id.
		const checks = [
			...this.#checks(target, 'doctor', {}).filter((check) => !(check.status === 'skip' && covered.has(check.id) && check.evidence[0] === NOT_REQUIRED)),
			...health,
		];
		const { ok, counts } = summarizeHaChecks(target, checks);
		return {
			profile: target,
			mode: 'doctor',
			ok: ok && counts.fail === 0,
			counts,
			checks,
			generatedAt: new Date(this.ctx.now()).toISOString(),
		};
	}

	/**
	 * Run the W3 conditional-write probe against the platform object store (the arbiter, W9) and
	 * cache the result for a minute. The probe object lives under `yoal/ha/` (the arbiter's prefix,
	 * HA-PLAN §10) and is deleted afterwards. Never throws.
	 */
	async probeArbiter(options: { force?: boolean } = {}): Promise<void> {
		const now = this.ctx.now();
		if (!options.force && this.#arbiter && now - this.#arbiter.at < ARBITER_PROBE_TTL_MS) return;
		const store = this.ctx.objectStore;
		if (store.kind === 'local') {
			this.#arbiter = { support: 'none', detail: 'the platform object store is the control host’s disk', kind: store.kind, at: now };
			return;
		}
		if (!isConditionalStore(store)) {
			this.#arbiter = { support: 'unsupported', detail: `the ${store.kind} store has no conditional write`, kind: store.kind, at: now };
			return;
		}
		const result = await probeConditionalWrites(store, `yoal/ha/preflight/cas-${randomUUID()}.json`);
		this.#arbiter = { support: result.support, detail: result.detail, kind: store.kind, at: this.ctx.now() };
	}

	/**
	 * A node's clock against this control plane's, from one heartbeat: the agent stamps the request
	 * (`x-yoal-agent-time`, epoch ms) and the control plane compares it on arrival. Transit time is
	 * inside the number, so it is an upper bound on how far behind a node is. In memory only.
	 */
	recordClock(nodeId: string, agentTimeMs: number, receivedAt: number): void {
		if (!Number.isFinite(agentTimeMs) || agentTimeMs <= 0) return;
		this.#clocks.set(nodeId, { skewMs: agentTimeMs - receivedAt, at: receivedAt });
	}

	/** The flags this control plane runs with (`YOAL_FEATURE_*` as resolved at start), for `/readyz`. */
	runningFlags(): Record<string, boolean> {
		return Object.fromEntries(FEATURE_FLAG_NAMES.map((name) => [name, featureEnabled(this.ctx.config, name)]));
	}

	/**
	 * Whether the selected steering driver, or one stacked on it, writes state at a provider (a
	 * keepalived VIP, DNS records, a webhook target) that turning it off would leave behind. A driver
	 * this build cannot load counts as writing: never assume nothing was written.
	 */
	steeringWrites(): boolean {
		const { driver, stacked } = this.ctx.cluster.get().steering;
		return [driver, ...stacked]
			.filter((kind) => kind !== 'direct')
			.some((kind) => {
				try {
					return this.ctx.steering.driver(kind).capabilities.writes;
				} catch {
					return true;
				}
			});
	}

	/** `ha-dependents`, with the steering entry's fix saying what a writing driver leaves behind. */
	#dependentChecks(): HaCheck[] {
		const checks = haDependentChecks(this.haDependents());
		if (!this.steeringWrites()) return checks;
		const { driver, stacked } = this.ctx.cluster.get().steering;
		const writers = [driver, ...stacked].filter((kind) => kind !== 'direct').join(' and ');
		return checks.map((check) =>
			check.id === 'ha-dependents' && check.subject?.kind === 'platform'
				? {
						...check,
						fix: {
							kind: 'manual' as const,
							value: `Set steering to direct, then withdraw what ${writers} put at the provider by hand (keepalived VIP, DNS records, webhook target): Settings → High availability → Steering, or cluster_config steering.driver = direct.`,
						},
					}
				: check,
		);
	}

	/**
	 * Everything that still depends on an HA feature, in `haDependentKinds` order: what
	 * `--profile single` must refuse on. Internal facts; no permission check.
	 */
	haDependents(): HaDependent[] {
		const sqlite = this.ctx.sqlite;
		const out: HaDependent[] = [];
		const databases = sqlite
			.query<{ id: string; name: string; durability: string; failover_mode: string }, []>(
				'SELECT id, name, durability, failover_mode FROM databases WHERE deleted_at IS NULL ORDER BY name',
			)
			.all();
		for (const row of databases) if (row.durability === 'sync') out.push({ kind: 'sync-database', id: row.id, name: row.name });
		for (const row of databases) if (row.failover_mode === 'auto') out.push({ kind: 'armed-database', id: row.id, name: row.name });
		// `workloads.endpoints_gateway` lands from the Wave 5 review-debt lane; read it once it exists.
		const workloadColumns = sqlite.query<{ name: string }, []>('PRAGMA table_info(workloads)').all().map((row) => row.name);
		if (workloadColumns.includes('endpoints_gateway'))
			for (const row of sqlite
				.query<{ id: string; slug: string | null }, []>(
					"SELECT w.id AS id, p.slug AS slug FROM workloads w LEFT JOIN projects p ON p.id = w.project_id WHERE coalesce(w.endpoints_gateway, 0) NOT IN (0, '0', '') ORDER BY w.id",
				)
				.all())
				out.push({ kind: 'gateway-attachment', id: row.id, name: row.slug ?? row.id });
		for (const row of sqlite
			.query<{ id: string; name: string }, []>(
				`SELECT n.id AS id, n.name AS name FROM control_state c JOIN nodes n ON n.id = c.node_id WHERE c.role IN (${STANDBY_ROLES.map(() => '?').join(', ')}) ORDER BY n.name`,
			)
			.all(...(STANDBY_ROLES as [])))
			out.push({ kind: 'control-standby', id: row.id, name: row.name });
		for (const row of sqlite
			.query<{ id: string; name: string }, []>("SELECT id, name FROM nodes WHERE region <> 'default' ORDER BY name")
			.all())
			out.push({ kind: 'region', id: row.id, name: row.name });
		const steering = this.ctx.cluster.get().steering;
		if (steering.driver !== 'direct' || steering.stacked.length > 0)
			out.push({ kind: 'steering', id: steering.driver, name: steering.driver });
		return out;
	}

	// ---------------------------------------------------------------- assembly

	#assert(principal: Principal): void {
		if (!this.ctx.platformIam.allows(principal, 'platform:ha'))
			throw new CoreError('forbidden', 'High availability is for platform operators and admins.', 403);
	}

	#checks(profile: HaProfile, mode: 'preflight' | 'doctor', answers: HaInitAnswers): HaCheck[] {
		const facts = this.#nodes();
		const ha = profile !== 'single';
		// On a running single install the HA-only checks are not the doctor's business.
		const haOnly = (id: HaCheckId, build: () => HaCheck[]): HaCheck[] =>
			ha || mode === 'preflight' ? build() : [skip(id, TITLES[id], [NOT_REQUIRED])];
		const plan = haInitPlan(profile === 'single' ? 'ha' : profile, answers);
		const planFlags = ha ? plan.flags.filter((flag) => flag.value).map((flag) => flag.name) : [];
		const steeringAnswer = plan.questions.find((question) => question.id === 'steering')?.value ?? 'external-lb';
		const certificates = (plan.questions.find((question) => question.id === 'certificates')?.value ?? 'shared') as HaCertificateSource;

		const checks: HaCheck[] = [
			...haOnly('nodes', () => this.#nodesCheck(profile, facts)),
			...haOnly('node-capabilities', () => this.#capabilitiesCheck(profile, facts, planFlags)),
			...haOnly('zones', () => this.#zonesCheck(profile, facts)),
			...haOnly('clocks', () => this.#clocksCheck(facts)),
			...haOnly('overlay-links', () => this.#overlayCheck(facts)),
			...haOnly('arbiter-conditional-writes', () => [this.#arbiterCheck()]),
			...haOnly('certificates', () => this.#certificatesCheck(profile, facts, certificates)),
			...haOnly('steering', () => this.#steeringCheck(profile, answers.steering ?? null, steeringAnswer as SteeringDriverKind)),
			...haOnly('backups', () => this.#backupsCheck()),
			...haOnly('headroom', () => this.#headroomCheck()),
		];
		// Lane A builds `regions`; until it does, say so honestly, beside the foundation's warning.
		for (const id of OTHER_LANE_CHECKS)
			checks.push({ id, title: TITLES[id], status: 'skip', evidence: ['Not checked yet: this check is built by Wave 5 lane A.'], fix: null, subject: null });
		checks.push(...this.#regionWarnings());
		const findings = haFindingChecks(haFindings(this.ctx, profile));
		checks.push(...findings);
		// A W12 check with no finding ran and found nothing to report.
		for (const id of W12_CHECKS)
			if (!findings.some((check) => check.id === id))
				checks.push({ id, title: TITLES[id], status: 'pass', evidence: ['Checked: nothing to report.'], fix: null, subject: null });
		checks.push(this.#flagsConsistent());
		checks.push(...this.#dependentChecks());
		// Display order is `haCheckIds`; entries of one id keep their order.
		const order = new Map(haCheckIds.map((id, index) => [id, index]));
		return checks
			.map((check, index) => ({ check, index }))
			.sort((a, b) => order.get(a.check.id)! - order.get(b.check.id)! || a.index - b.index)
			.map(({ check }) => check);
	}

	#nodes(): NodeFact[] {
		return this.ctx.db
			.select()
			.from(nodesTable)
			.all()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((row) => ({
				id: row.id,
				name: row.name,
				status: row.status,
				online: row.status === 'online',
				roles: rolesFor(row),
				zone: row.zone,
				capabilities: parseJson<string[]>(row.capabilitiesJson, []),
				row,
			}));
	}

	// ---------------------------------------------------------------- checks

	#nodesCheck(profile: HaProfile, facts: NodeFact[]): HaCheck[] {
		const title = TITLES.nodes;
		if (profile === 'single') return [pass('nodes', title, [`${plural(facts.length, 'node')}; the single profile needs one.`])];
		const online = facts.filter((node) => node.online);
		const count = (role: NodeRole) => online.filter((node) => node.roles.includes(role)).length;
		const needs: Array<{ role: NodeRole; min: number; why: string }> = [
			{ role: 'ingress', min: 2, why: 'the balancer needs a second ingress to fail over to' },
			{ role: 'compute', min: 2, why: 'app copies need a second node' },
			{ role: 'data', min: 2, why: 'a database needs a replica on another node' },
			{ role: 'control', min: 2, why: 'the control plane needs a standby' },
		];
		const evidence = [
			`${plural(online.length, 'online node')} of ${facts.length}.`,
			...needs.map((need) => `${need.role}: ${count(need.role)} online (needs ${need.min}).`),
		];
		const offline = facts.filter((node) => !node.online);
		if (offline.length > 0) evidence.push(`Not online: ${offline.map((node) => `${node.name} (${node.status})`).join(', ')}.`);
		const missing = needs.filter((need) => count(need.role) < need.min);
		if (missing.length > 0)
			return [
				{
					id: 'nodes',
					title: 'Not enough nodes with the HA roles',
					status: 'fail',
					evidence: [...evidence, ...missing.map((need) => `Too few ${need.role} nodes: ${need.why}.`)],
					fix: {
						kind: 'command',
						value: `Add nodes with the missing roles (${missing.map((need) => need.role).join(', ')}): yoal nodes enrol prints the join line; on the machine run node.sh --roles ${missing.map((need) => need.role).join(',')} --zone <zone>. Or set roles on an existing node: Nodes → Edit node → Roles.`,
					},
					subject: null,
				},
			];
		if (count('data') < 3)
			return [
				{
					id: 'nodes',
					title: 'Two data nodes: automatic database failover holds and pages',
					status: 'warn',
					evidence: [...evidence, 'With two data nodes a lost primary is not promoted automatically (CLUSTERING §21, R6); three data nodes in three zones allow it.'],
					fix: { kind: 'manual', value: 'Add a third data node in a third zone for automatic database failover.' },
					subject: null,
				},
			];
		return [pass('nodes', title, evidence)];
	}

	#capabilitiesCheck(profile: HaProfile, facts: NodeFact[], planFlags: FeatureName[]): HaCheck[] {
		const title = TITLES['node-capabilities'];
		if (profile === 'single') return [pass('node-capabilities', title, ['The single profile needs no agent capability.'])];
		const online = facts.filter((node) => node.online);
		if (online.length === 0) return [skip('node-capabilities', title, ['No node is online, so no agent has reported its capabilities.'])];
		const out: HaCheck[] = [];
		const store = this.ctx.objectStore.kind;
		const needs = [
			...FLAG_CAPABILITIES.filter((entry) => planFlags.includes(entry.flag)),
			// An Azure or GCS platform store reaches the data nodes through PITR and Litestream (W3).
			...(store === 'azure' || store === 'gcs' ? [{ flag: null, capability: OBJECT_STORE_KINDS_CAPABILITY, roles: ['data'] as NodeRole[] }] : []),
		];
		for (const node of online) {
			const missing = [
				...new Set(
					needs
						.filter((need) => need.roles === 'all' || need.roles.some((role) => node.roles.includes(role)))
						.filter((need) => !node.capabilities.includes(need.capability))
						.map((need) => need.capability),
				),
			];
			if (missing.length === 0) continue;
			out.push({
				id: 'node-capabilities',
				title: `${node.name} runs an agent without ${missing.join(', ')}`,
				status: 'fail',
				evidence: [`${node.name} (agent ${node.row.agentVersion ?? 'unknown'}, roles ${node.roles.join(', ')}) does not declare ${missing.join(', ')}.`],
				fix: { kind: 'command', value: `yoal nodes update ${node.name}` },
				subject: subject('node', node.id, node.name),
			});
		}
		const evidence = [`${plural(online.length, 'online node')} declare every capability the ${profile} profile's flags need.`];
		if (planFlags.includes('DB_AUTO_PROMOTE') && !online.some((node) => node.capabilities.includes(DB_MEMBER_SELF_FENCING_CAPABILITY)))
			evidence.push('No node declares db-member-self-fencing, so DB_AUTO_PROMOTE stays inert: automatic database failover cannot be armed yet.');
		return out.length > 0 ? out : [pass('node-capabilities', title, evidence)];
	}

	#zonesCheck(profile: HaProfile, facts: NodeFact[]): HaCheck[] {
		const title = TITLES.zones;
		if (profile === 'single') return [pass('zones', title, ['The single profile needs no zones.'])];
		const online = facts.filter((node) => node.online);
		const out: HaCheck[] = [];
		const evidence: string[] = [];
		for (const role of ['ingress', 'data', 'control'] as const) {
			const holders = online.filter((node) => node.roles.includes(role));
			const zones = [...new Set(holders.map((node) => node.zone))].sort();
			evidence.push(`${role}: ${plural(holders.length, 'node')} in ${plural(zones.length, 'zone')} (${zones.join(', ') || 'none'}).`);
			if (holders.length >= 2 && zones.length < 2) {
				const node = holders[holders.length - 1]!;
				out.push({
					id: 'zones',
					title: `Every ${role} node is in one zone`,
					status: 'fail',
					evidence: [`${holders.map((item) => item.name).join(', ')} are all in zone ${zones[0]}; losing that zone loses every ${role} node.`],
					fix: { kind: 'setting', value: editNode(node, 'Zone', '"<another zone>"') },
					subject: subject('zone', zones[0]!, zones[0]!),
				});
			}
		}
		// Fewer than two holders is the `nodes` check's failure; do not report it twice.
		return out.length > 0 ? out : [pass('zones', title, evidence)];
	}

	#clocksCheck(facts: NodeFact[]): HaCheck[] {
		const title = TITLES.clocks;
		const now = this.ctx.now();
		const online = facts.filter((node) => node.online);
		if (online.length === 0) return [skip('clocks', title, ['No node is online, so there is no heartbeat to compare clocks with.'])];
		const out: HaCheck[] = [];
		const unknown: string[] = [];
		const evidence: string[] = [];
		for (const node of online) {
			const sample = this.#clocks.get(node.id);
			if (!sample || now - sample.at > CLOCK_SAMPLE_MAX_AGE_MS) {
				unknown.push(node.name);
				continue;
			}
			const abs = Math.abs(sample.skewMs);
			const line = `${node.name} is ${seconds(abs)} ${sample.skewMs >= 0 ? 'ahead of' : 'behind'} this control plane (heartbeat transit included).`;
			if (abs <= CLOCK_SKEW_WARN_MS) {
				evidence.push(line);
				continue;
			}
			out.push({
				id: 'clocks',
				title: `${node.name}'s clock is off`,
				status: abs > CLOCK_SKEW_FAIL_MS ? 'fail' : 'warn',
				evidence: [line, `The lease tolerates ${seconds(CLOCK_SKEW_FAIL_MS)}.`],
				fix: { kind: 'manual', value: `Run NTP on ${node.name} (timedatectl set-ntp true; chronyc tracking shows the offset).` },
				subject: subject('node', node.id, node.name),
			});
		}
		if (unknown.length > 0)
			out.push(
				skip('clocks', `No clock reading from ${unknown.join(', ')}`, [
					`${unknown.join(', ')} has not sent a timed heartbeat to this control plane in the last 5 minutes (an older agent does not stamp its heartbeat, and a control plane that just started has not heard from it yet).`,
				]),
			);
		return out.length > 0 ? out : [pass('clocks', title, evidence)];
	}

	#overlayCheck(facts: NodeFact[]): HaCheck[] {
		const title = TITLES['overlay-links'];
		const now = this.ctx.now();
		const involved = facts.filter(
			(node) => node.online && node.roles.some((role) => role === 'ingress' || role === 'data' || role === 'control'),
		);
		if (involved.length < 2) return [skip('overlay-links', title, ['Fewer than two ingress, data or control nodes are online, so there is no link to check.'])];
		const onOverlay = (node: NodeFact) => node.row.networkMode !== 'external' && Boolean(node.row.wgPublicKey);
		// Passive round trips (D216) cover links that are not on the managed overlay.
		const samples = new Map(
			this.ctx.sqlite
				.query<{ from_node_id: string; to_node_id: string; rtt_ms: number | null; sampled_at: number | null; down_since: number | null }, []>(
					'SELECT from_node_id, to_node_id, rtt_ms, sampled_at, down_since FROM node_links',
				)
				.all()
				.map((row) => [`${row.from_node_id}>${row.to_node_id}`, row]),
		);
		const out: HaCheck[] = [];
		const unmeasured: string[] = [];
		let up = 0;
		for (const node of involved) {
			const report = parseJson<{ peers?: Array<{ publicKey: string; latestHandshakeAt: string | null }> } | null>(node.row.wgStatusJson, null);
			const reportFresh = report !== null && node.row.wgStatusAt !== null && now - node.row.wgStatusAt <= OVERLAY_REPORT_MAX_AGE_MS;
			for (const peer of involved) {
				if (peer.id === node.id) continue;
				const label = `${node.name} → ${peer.name}`;
				let down: string | null = null;
				if (onOverlay(node) && onOverlay(peer) && reportFresh) {
					const seen = (report!.peers ?? []).find((item) => item.publicKey === peer.row.wgPublicKey);
					const handshake = seen?.latestHandshakeAt ? Date.parse(seen.latestHandshakeAt) : Number.NaN;
					const age = Number.isFinite(handshake) ? node.row.wgStatusAt! - handshake : null;
					if (age !== null && age <= OVERLAY_HANDSHAKE_MAX_AGE_MS) {
						up += 1;
						continue;
					}
					down = !seen
						? `${node.name} has no WireGuard peer for ${peer.name}.`
						: age === null
							? `${node.name} has never completed a WireGuard handshake with ${peer.name}.`
							: `${node.name}'s last WireGuard handshake with ${peer.name} was ${Math.round(age / 1000)} s ago (a live link re-handshakes within ${OVERLAY_HANDSHAKE_MAX_AGE_MS / 1000} s).`;
				} else {
					const sample = samples.get(`${node.id}>${peer.id}`);
					if (!sample || sample.sampled_at === null || now - sample.sampled_at > OVERLAY_REPORT_MAX_AGE_MS) {
						unmeasured.push(label);
						continue;
					}
					if (sample.down_since === null && sample.rtt_ms !== null) {
						up += 1;
						continue;
					}
					down = `${node.name} gets no answer from ${peer.name}${sample.down_since === null ? '' : ` since ${new Date(sample.down_since).toISOString()}`}.`;
				}
				out.push({
					id: 'overlay-links',
					title: `Link ${label} is down`,
					status: 'fail',
					evidence: [down],
					fix: {
						kind: 'manual',
						value: onOverlay(peer)
							? `Allow UDP ${peer.row.wgListenPort ?? 51820} from ${node.name} to ${peer.row.wgEndpoint ?? peer.name}, then check with yoal fleet links.`
							: `Open the path from ${node.name} to ${peer.name} on your network, then check with yoal fleet links.`,
					},
					subject: subject('node', node.id, node.name),
				});
			}
		}
		if (unmeasured.length > 0)
			out.push(
				skip('overlay-links', 'Some links are not measured', [
					`No WireGuard handshake or round-trip sample in the last 5 minutes for: ${unmeasured.slice(0, 12).join(', ')}${unmeasured.length > 12 ? ` and ${unmeasured.length - 12} more` : ''}.`,
					'Agents that declare link-tests sample their peers every minute; yoal fleet links shows them.',
				]),
			);
		return out.length > 0 ? out : [pass('overlay-links', title, [`${plural(up, 'link')} between ${plural(involved.length, 'node')} answered in the last 5 minutes.`])];
	}

	#arbiterCheck(): HaCheck {
		const title = TITLES['arbiter-conditional-writes'];
		const probe = this.#arbiter;
		const env = (detail: string): HaCheck => ({
			id: 'arbiter-conditional-writes',
			title: 'The arbiter cannot do conditional writes',
			status: 'fail',
			evidence: [detail],
			fix: {
				kind: 'env',
				value: 'YOAL_OBJECT_STORE=s3 (or azure, gcs) with a store that honours If-None-Match and If-Match, plus its credentials, in yoal.env; then restart the control plane.',
			},
			subject: null,
		});
		if (!probe)
			return skip('arbiter-conditional-writes', title, ['Not probed yet: the conditional-write probe runs when the preflight is read through the API (GET /api/v1/ha/preflight).']);
		const at = new Date(probe.at).toISOString();
		if (probe.support === 'supported')
			return pass('arbiter-conditional-writes', title, [`The ${probe.kind} store won and lost the create, replace and stale-replace writes correctly (probed ${at}).`]);
		if (probe.support === 'none') return env(`No arbiter: ${probe.detail}.`);
		if (probe.support === 'unsupported') return env(`The ${probe.kind} store failed the probe: ${probe.detail} (probed ${at}).`);
		return {
			id: 'arbiter-conditional-writes',
			title: 'The arbiter probe did not finish',
			status: 'fail',
			evidence: [`The ${probe.kind} store could not be probed: ${probe.detail ?? 'unknown error'} (probed ${at}).`],
			fix: { kind: 'manual', value: 'Check that this control plane reaches the object store and its credentials allow put, get and delete under yoal/ha/, then re-run the preflight.' },
			subject: null,
		};
	}

	#certificatesCheck(profile: HaProfile, facts: NodeFact[], source: HaCertificateSource): HaCheck[] {
		const title = TITLES.certificates;
		if (profile === 'single') return [pass('certificates', title, ['The single profile serves from one node.'])];
		const ingress = facts.filter((node) => node.online && node.roles.includes('ingress'));
		if (ingress.length === 0) return [skip('certificates', title, ['No ingress node is online.'])];
		if (source === 'per-node')
			return [
				pass('certificates', title, [
					`Each of ${plural(ingress.length, 'ingress node')} issues its own certificates (per-node). A new ingress issues before it serves.`,
				]),
			];
		if (!featureEnabled(this.ctx.config, 'SHARED_CERTIFICATES'))
			return [
				{
					id: 'certificates',
					title: 'Shared certificates are off',
					status: 'fail',
					evidence: ['Every ingress issues its own certificate, so each needs its own ACME challenge and the balancer may see different certificates.'],
					fix: { kind: 'env', value: `${featureEnvKey('SHARED_CERTIFICATES')}=1` },
					subject: null,
				},
			];
		const out: HaCheck[] = [];
		const fingerprints = new Map<string, string[]>();
		for (const node of ingress) {
			const value = node.row.certificateFingerprint;
			if (!value) {
				out.push({
					id: 'certificates',
					title: `${node.name} has not loaded the shared certificate`,
					status: 'fail',
					evidence: [`${node.name} reports no certificate fingerprint.`],
					fix: { kind: 'manual', value: `Check ${node.name}'s agent log for the certificate fetch (journalctl -u yoal-agent), and that it declares ingress-set.` },
					subject: subject('ingress', node.id, node.name),
				});
				continue;
			}
			fingerprints.set(value, [...(fingerprints.get(value) ?? []), node.name]);
		}
		if (fingerprints.size > 1)
			out.push({
				id: 'certificates',
				title: 'Ingress nodes serve different certificates',
				status: 'fail',
				evidence: [...fingerprints.entries()].map(([value, names]) => `${names.join(', ')}: ${value.slice(0, 16)}…`),
				fix: { kind: 'manual', value: 'Wait one heartbeat after a renewal; if it persists, restart the agent on the odd node so it fetches the current certificate.' },
				subject: null,
			});
		return out.length > 0
			? out
			: [pass('certificates', title, [`${plural(ingress.length, 'ingress node')} serve one certificate set (${[...fingerprints.keys()][0]!.slice(0, 16)}…).`])];
	}

	#steeringCheck(profile: HaProfile, answered: SteeringDriverKind | null, planned: SteeringDriverKind): HaCheck[] {
		const title = TITLES.steering;
		if (profile === 'single') return [pass('steering', title, ['The single profile has no steering.'])];
		const stored = this.ctx.cluster.get().steering.driver;
		const kind = answered ?? (stored !== 'direct' ? stored : planned);
		const out: HaCheck[] = [];
		if (!featureEnabled(this.ctx.config, 'STEERING'))
			out.push({
				id: 'steering',
				title: 'Steering is off',
				status: 'fail',
				evidence: [`The ${kind} driver does nothing while STEERING is off.`],
				fix: { kind: 'env', value: `${featureEnvKey('STEERING')}=1` },
				subject: null,
			});
		let findings: Array<{ nodeId: string | null; reason: string }>;
		try {
			findings = this.ctx.steering.driver(kind).preflight();
		} catch (error) {
			return [
				...out,
				{
					id: 'steering',
					title: `The ${kind} driver cannot run`,
					status: 'fail',
					evidence: [(error as Error).message],
					fix: { kind: 'setting', value: 'Choose another driver: yoal ha init --steering <driver> (Settings → High availability → Steering).' },
					subject: null,
				},
			];
		}
		const names = new Map(this.#nodes().map((node) => [node.id, node.name]));
		for (const finding of findings)
			out.push({
				id: 'steering',
				title: finding.nodeId ? `The ${kind} driver cannot steer ${names.get(finding.nodeId) ?? finding.nodeId}` : `The ${kind} driver is not ready`,
				status: 'fail',
				evidence: [finding.reason],
				fix: { kind: 'manual', value: finding.reason },
				subject: finding.nodeId ? subject('ingress', finding.nodeId, names.get(finding.nodeId) ?? finding.nodeId) : null,
			});
		return out.length > 0 ? out : [pass('steering', title, [`The ${kind} driver's preflight passes${kind === stored ? '' : ' (not selected yet: ha init selects it)'}.`])];
	}

	#backupsCheck(): HaCheck[] {
		const title = TITLES.backups;
		const now = this.ctx.now();
		const databases = this.ctx.sqlite
			.query<{ id: string; name: string }, []>('SELECT id, name FROM databases WHERE deleted_at IS NULL ORDER BY name')
			.all();
		if (databases.length === 0) return [pass('backups', title, ['There is no database to back up.'])];
		const out: HaCheck[] = [];
		const evidence: string[] = [];
		for (const database of databases) {
			const pitr = this.ctx.sqlite
				.query<{ enabled: number; status: string; last: number | null }, [string]>(
					'SELECT enabled, status, last_base_backup_at AS last FROM database_pitr WHERE database_id = ?',
				)
				.get(database.id);
			const backup = this.ctx.sqlite
				.query<
					{ finished: number | null; verified: number | null; kind: string | null; lock: number | null; retention: number | null; target: string | null },
					[string]
				>(
					`SELECT b.finished_at AS finished, b.verified_at AS verified, t.kind AS kind, t.object_lock AS lock,
					        t.immutable_retention_days AS retention, coalesce(t.name, b.target_name) AS target
					   FROM database_backups b LEFT JOIN backup_targets t ON t.id = b.target_id
					  WHERE b.database_id = ? AND b.status = 'ok' AND b.target_id IS NOT NULL
					  ORDER BY coalesce(b.finished_at, b.created_at) DESC LIMIT 1`,
				)
				.get(database.id);
			const about = subject('database', database.id, database.name);
			const pitrOk = pitr && pitr.enabled === 1 && pitr.status === 'ok';
			const offNode = backup && backup.kind !== null && backup.kind !== 'local';
			const fresh = backup?.finished !== null && backup?.finished !== undefined && now - backup.finished <= BACKUP_MAX_AGE_MS;
			if (!pitrOk && !(offNode && fresh)) {
				out.push({
					id: 'backups',
					title: `${database.name} has no recent off-node backup`,
					status: 'fail',
					evidence: [
						backup
							? `Last backup ${backup.finished ? `${Math.round((now - backup.finished) / 3_600_000)} h ago` : 'unfinished'} to ${backup.target ?? 'a target'} (${backup.kind ?? 'unknown kind'}).`
							: 'No successful backup to a backup target.',
						pitr ? `PITR is ${pitr.enabled ? pitr.status : 'off'}.` : 'PITR is off.',
					],
					fix: {
						kind: 'setting',
						value: `Databases → ${database.name} → Backups: choose an S3, Azure or GCS backup target, then take one now: yoal db backup ${database.name}`,
					},
					subject: about,
				});
				continue;
			}
			const immutable = offNode && (backup!.lock === 1 || (backup!.retention ?? 0) > 0);
			const verified = offNode && backup!.verified !== null;
			const line = pitrOk ? `${database.name}: PITR is archiving.` : `${database.name}: backed up to ${backup!.target} ${Math.round((now - backup!.finished!) / 3_600_000)} h ago.`;
			if (!pitrOk && (!immutable || !verified)) {
				out.push({
					id: 'backups',
					title: `${database.name}'s backups are not ${!verified ? 'verified' : 'immutable'}`,
					status: 'warn',
					evidence: [line, !verified ? 'No restore of the last backup has been verified.' : 'The target has neither object lock nor immutable retention.'],
					fix: !verified
						? { kind: 'command', value: `yoal db restore-backup ${database.name} <backup-id> --as ${database.name}-verify (yoal db backups ${database.name} lists the ids)` }
						: { kind: 'setting', value: `Settings → Backups → ${backup!.target} → Immutable retention` },
					subject: about,
				});
				continue;
			}
			evidence.push(line);
		}
		return out.length > 0 ? out : [pass('backups', title, evidence)];
	}

	#headroomCheck(): HaCheck[] {
		const title = TITLES.headroom;
		let snapshot: ReturnType<CoreContext['workloads']['balanceSnapshot']>;
		try {
			snapshot = this.ctx.workloads.balanceSnapshot();
		} catch (error) {
			return [skip('headroom', title, [`The capacity snapshot failed: ${(error as Error).message}`])];
		}
		const eligible = snapshot.nodes.filter((node) => node.eligible);
		if (eligible.length < 2) return [skip('headroom', title, ['Fewer than two nodes can hold copies, so there is nowhere to fail over to.'])];
		const free = (list: typeof eligible) => list.reduce((sum, node) => sum + Math.max(0, node.capacityMb - node.reservedMb), 0);
		const out: HaCheck[] = [];
		const evidence: string[] = [];
		for (const node of eligible) {
			const rest = eligible.filter((other) => other.id !== node.id);
			const room = free(rest);
			const line = `Losing ${node.name} moves ${node.reservedMb} MiB; the others have ${room} MiB free.`;
			if (node.reservedMb > room)
				out.push({
					id: 'headroom',
					title: `The fleet cannot absorb ${node.name}`,
					status: 'fail',
					evidence: [line],
					fix: { kind: 'manual', value: `Add ${node.reservedMb - room} MiB of capacity (a node, or a larger slice), or lower copies' memory.` },
					subject: subject('node', node.id, node.name),
				});
			else evidence.push(line);
		}
		const zones = [...new Set(eligible.map((node) => node.zone))].sort();
		if (zones.length > 1)
			for (const zone of zones) {
				const inside = eligible.filter((node) => node.zone === zone);
				const moved = inside.reduce((sum, node) => sum + node.reservedMb, 0);
				const room = free(eligible.filter((node) => node.zone !== zone));
				const line = `Losing zone ${zone} moves ${moved} MiB; the other zones have ${room} MiB free.`;
				if (moved > room)
					out.push({
						id: 'headroom',
						title: `The fleet cannot absorb zone ${zone}`,
						status: 'warn',
						evidence: [line],
						fix: { kind: 'manual', value: `Add ${moved - room} MiB of capacity outside zone ${zone}.` },
						subject: subject('zone', zone, zone),
					});
				else evidence.push(line);
			}
		return out.length > 0 ? out : [pass('headroom', title, evidence)];
	}

	/** Doctor only: each node's heartbeat, Caddy, drift, agent version and disk. */
	#nodeHealth(): HaCheck[] {
		const out: HaCheck[] = [];
		const now = this.ctx.now();
		const desiredVersion = this.ctx.nodes.stateVersion();
		const agentVersion = this.ctx.config.desiredAgentVersion ?? null;
		for (const node of this.#nodes()) {
			const about = subject('node', node.id, node.name);
			const row = node.row;
			const silent = row.lastHeartbeatAt === null ? null : now - row.lastHeartbeatAt;
			if (row.lastHeartbeatAt === null)
				out.push({
					id: 'nodes',
					title: `${node.name} has never sent a heartbeat`,
					status: node.status === 'pending' ? 'warn' : 'fail',
					evidence: [`${node.name} is ${node.status} and has not reported.`],
					fix: { kind: 'manual', value: `Start the agent on ${node.name}: systemctl start yoal-agent; journalctl -u yoal-agent shows why it cannot reach the control plane.` },
					subject: about,
				});
			else if (silent! > 30_000 && node.status !== 'draining')
				out.push({
					id: 'nodes',
					title: `${node.name} is silent`,
					status: 'fail',
					evidence: [`Last heartbeat ${Math.round(silent! / 1000)} s ago.`],
					fix: { kind: 'manual', value: `Check ${node.name}: systemctl status yoal-agent, and that it reaches the control plane.` },
					subject: about,
				});
			else if (node.status === 'offline')
				out.push({
					id: 'nodes',
					title: `${node.name}'s Caddy config is not applied`,
					status: 'fail',
					evidence: [`${node.name} heartbeats but reports Caddy not OK, so it is offline.`],
					fix: { kind: 'manual', value: `On ${node.name}: journalctl -u yoal-caddy and journalctl -u yoal-agent for the rejected config.` },
					subject: about,
				});
			else if (row.actualStateVersion !== null && row.actualStateVersion < desiredVersion && row.actualStateAt !== null && now - row.actualStateAt > 120_000)
				out.push({
					id: 'nodes',
					title: `${node.name} is behind the desired state`,
					status: 'warn',
					evidence: [`${node.name} applied v${row.actualStateVersion}; the control plane is at v${desiredVersion}, for ${Math.round((now - row.actualStateAt) / 1000)} s.`],
					fix: { kind: 'manual', value: `journalctl -u yoal-agent on ${node.name} shows why the last pull did not apply.` },
					subject: about,
				});
			else
				out.push(
					pass(
						'nodes',
						`${node.name} is healthy`,
						[
							`${node.status}; last heartbeat ${silent === null ? 'never' : `${Math.round(silent / 1000)} s`} ago; Caddy applied; desired state ${row.actualStateVersion === null ? 'not reported' : `v${row.actualStateVersion} of v${desiredVersion}`}.`,
						],
						about,
					),
				);

			if (agentVersion && row.agentVersion && row.agentVersion !== agentVersion)
				out.push({
					id: 'node-capabilities',
					title: `${node.name} runs agent ${row.agentVersion}`,
					status: 'warn',
					evidence: [`${node.name} runs ${row.agentVersion}; the control plane ships ${agentVersion}.`],
					fix: { kind: 'command', value: `yoal nodes update ${node.name}` },
					subject: about,
				});
			else if (row.agentVersion) out.push(pass('node-capabilities', `${node.name} runs agent ${row.agentVersion}`, [`Matches the control plane's agent version.`], about));

			const stats = parseJson<{ diskUsedBytes?: number; diskTotalBytes?: number; diskFreeBytes?: number } | null>(row.statsJson, null);
			if (stats && typeof stats.diskTotalBytes === 'number' && stats.diskTotalBytes > 0) {
				const free = stats.diskFreeBytes ?? stats.diskTotalBytes - (stats.diskUsedBytes ?? 0);
				const used = Math.round(((stats.diskTotalBytes - free) / stats.diskTotalBytes) * 100);
				const line = `${node.name}'s data disk is ${used}% full (${Math.round(free / 1024 ** 3)} GiB free).`;
				out.push(
					used >= DISK_WARN_PERCENT
						? {
								id: 'headroom',
								title: `${node.name}'s data disk is ${used}% full`,
								status: used >= DISK_FAIL_PERCENT ? 'fail' : 'warn',
								evidence: [line],
								fix: { kind: 'manual', value: `Free space on ${node.name}: yoal prune --apply removes old releases and images; or grow its data disk.` },
								subject: about,
							}
						: pass('headroom', `${node.name}'s data disk`, [line], about),
				);
			} else out.push(skip('headroom', `${node.name}'s data disk`, ['The node has not reported disk use yet.'], about));
		}
		return out;
	}

	#flagsConsistent(): HaCheck {
		const own = this.runningFlags();
		const hosts = [
			{ name: 'this control plane', flags: own as Record<string, boolean> },
			...this.ctx.sqlite
				.query<{ name: string; flags: string | null }, []>(
					'SELECT n.name AS name, c.feature_flags_json AS flags FROM control_state c JOIN nodes n ON n.id = c.node_id ORDER BY n.name',
				)
				.all()
				.map((row) => ({ name: row.name, flags: row.flags ? parseJson<Record<string, boolean> | null>(row.flags, null) : null })),
		];
		const drift = featureFlagDrift(hosts);
		const title = TITLES['flags-consistent'];
		if (drift.differences.length > 0)
			return {
				id: 'flags-consistent',
				title,
				status: 'fail',
				evidence: drift.differences.map(
					(item) => `${item.flag}: ${Object.entries(item.values).map(([host, value]) => `${host} ${value === null ? 'unset' : value ? 'on' : 'off'}`).join(', ')}`,
				),
				fix: {
					kind: 'env',
					value: `Make ${drift.differences.map((item) => featureEnvKey(item.flag as never)).join(', ')} the same in yoal.env on every control-plane host, then restart each control plane.`,
				},
				subject: null,
			};
		if (drift.unreported.length > 0)
			return {
				id: 'flags-consistent',
				title,
				status: 'warn',
				evidence: [`Cannot verify ${drift.unreported.join(', ')}: its control plane does not report its flags.`],
				fix: { kind: 'manual', value: `Update ${drift.unreported.join(', ')} to this release so it reports its flags.` },
				subject: null,
			};
		return { id: 'flags-consistent', title, status: 'pass', evidence: [`${hosts.length} control-plane host(s) agree.`], fix: null, subject: null };
	}

	/** Region values stored while `REGIONS` is off: placed as zone, never an error; a warning here. */
	#regionWarnings(): HaCheck[] {
		if (featureEnabled(this.ctx.config, 'REGIONS')) return [];
		const evidence: string[] = [];
		if (this.ctx.cluster.get().replicas.spread === 'region') evidence.push('cluster replicas.spread is region');
		for (const row of this.ctx.sqlite
			.query<{ slug: string; placement: string | null; workload: string | null }, []>(
				'SELECT slug, placement_json AS placement, workload_json AS workload FROM projects WHERE deleted_at IS NULL ORDER BY slug',
			)
			.all()) {
			if (parseJson<{ spread?: string } | null>(row.placement, null)?.spread === 'region') evidence.push(`project ${row.slug} placementSpec.spread is region`);
			if (parseJson<{ placement?: { spread?: string } } | null>(row.workload, null)?.placement?.spread === 'region')
				evidence.push(`project ${row.slug} placement.spread is region`);
		}
		for (const row of this.ctx.sqlite.query<{ name: string; region: string }, []>("SELECT name, region FROM nodes WHERE region <> 'default' ORDER BY name").all())
			evidence.push(`node ${row.name} is in region ${row.region}`);
		for (const row of this.ctx.sqlite
			.query<{ name: string; region: string }, []>('SELECT name, standby_region AS region FROM databases WHERE standby_region IS NOT NULL AND deleted_at IS NULL ORDER BY name')
			.all())
			evidence.push(`database ${row.name} has standby region ${row.region}`);
		if (evidence.length === 0) return [];
		return [
			{
				id: 'regions',
				title: 'Region values are stored while regions are off',
				status: 'warn',
				evidence: [...evidence, 'A spread: region is placed as zone while REGIONS is off.'],
				fix: { kind: 'env', value: 'YOAL_FEATURE_REGIONS=1, or put each value back to node/zone and the default region.' },
				subject: null,
			},
		];
	}
}
