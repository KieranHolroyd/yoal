import BotIcon from '@lucide/svelte/icons/bot';
import BoxesIcon from '@lucide/svelte/icons/boxes';
import DatabaseBackupIcon from '@lucide/svelte/icons/database-backup';
import DatabaseIcon from '@lucide/svelte/icons/database';
import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
import ListOrderedIcon from '@lucide/svelte/icons/list-ordered';
import MailIcon from '@lucide/svelte/icons/mail';
import NetworkIcon from '@lucide/svelte/icons/network';
import ServerCogIcon from '@lucide/svelte/icons/server-cog';
import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
import WorkflowIcon from '@lucide/svelte/icons/workflow';
import type { SystemSettingArea } from '@yoal/contracts';

export interface AreaMeta {
	area: SystemSettingArea;
	title: string;
	blurb: string;
	icon: typeof BotIcon;
}

/** Page order: sign-in first, then the feature areas roughly by how often they are touched. */
export const AREAS: AreaMeta[] = [
	{
		area: 'access',
		title: 'Sign-in and access',
		blurb: 'Who can create an account and how owners prove it is them.',
		icon: ShieldCheckIcon
	},
	{
		area: 'workloads',
		title: 'Workloads',
		blurb: 'Functions, compose stacks, consoles and how apps spread and move.',
		icon: BoxesIcon
	},
	{
		area: 'databases',
		title: 'Databases',
		blurb: 'Studio, TLS, pooling, public access and replica promotion.',
		icon: DatabaseIcon
	},
	{
		area: 'backups',
		title: 'Backups',
		blurb: 'Database backups, restore and point-in-time recovery.',
		icon: DatabaseBackupIcon
	},
	{
		area: 'storage',
		title: 'Storage',
		blurb: 'The object browser, media and extra object-store backends.',
		icon: HardDriveIcon
	},
	{
		area: 'networking',
		title: 'Networking',
		blurb: 'Org networks, service endpoints, ingress and failover.',
		icon: NetworkIcon
	},
	{ area: 'queues', title: 'Queues', blurb: 'Managed message brokers.', icon: ListOrderedIcon },
	{ area: 'email', title: 'Email', blurb: "Yoal's own mail server.", icon: MailIcon },
	{
		area: 'automation',
		title: 'Automation',
		blurb: 'Jobs, blueprints and preview data.',
		icon: WorkflowIcon
	},
	{
		area: 'agents',
		title: 'Agents and MCP',
		blurb: 'What MCP clients and agents may register and change.',
		icon: BotIcon
	},
	{
		area: 'platform',
		title: 'Platform',
		blurb: 'Quotas, upgrades, SLOs, probing and regions.',
		icon: ServerCogIcon
	}
];
