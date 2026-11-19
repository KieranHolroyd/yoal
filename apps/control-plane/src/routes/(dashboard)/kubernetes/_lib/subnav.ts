import { resolve } from '$app/paths';
import ArchiveIcon from '@lucide/svelte/icons/archive';
import GlobeIcon from '@lucide/svelte/icons/globe';
import LogsIcon from '@lucide/svelte/icons/logs';
import KeyRoundIcon from '@lucide/svelte/icons/key-round';
import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
import PlugIcon from '@lucide/svelte/icons/plug';
import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
import Settings2Icon from '@lucide/svelte/icons/settings-2';
import ShipWheelIcon from '@lucide/svelte/icons/ship-wheel';
import SparklesIcon from '@lucide/svelte/icons/sparkles';
import type { KubernetesClusterView } from '@yoal/contracts';
import type { Subnav, RouteUrl } from '#lib/nav/subnav.js';
import { readTab, tabHref } from '../../_lib/service/sections.js';
import { KUBERNETES_DEFAULT_TAB, KUBERNETES_TABS } from './kubernetes-tabs.js';

export const clusterSubnavKey = (name: string) => `kubernetes:${name}`;

/** A cluster's sections; Logs is its own route. */
export function clusterSubnav(
	data: { cluster: KubernetesClusterView },
	url: RouteUrl,
	route: 'logs' | null
): Subnav {
	const cluster = data.cluster;
	const base = resolve('/(dashboard)/kubernetes/[name]', { name: cluster.name });
	const tab = (id: (typeof KUBERNETES_TABS)[number]) => tabHref(base, id, KUBERNETES_DEFAULT_TAB);
	return {
		key: clusterSubnavKey(cluster.name),
		depth: 1,
		title: cluster.name,
		mono: true,
		icon: ShipWheelIcon,
		back: { href: resolve('/(dashboard)/kubernetes'), label: 'Kubernetes' },
		active: route ?? readTab(url.searchParams.get('tab'), KUBERNETES_TABS, KUBERNETES_DEFAULT_TAB),
		target: 'service.tab',
		groups: [
			{
				id: 'sections',
				items: [
					{ id: 'overview', label: 'Overview', icon: LayoutDashboardIcon, href: tab('overview') },
					{ id: 'access', label: 'Access', icon: KeyRoundIcon, href: tab('access') },
					{ id: 'routes', label: 'Routes', icon: GlobeIcon, href: tab('routes') },
					{ id: 'attachments', label: 'Attachments', icon: PlugIcon, href: tab('attachments') },
					{ id: 'backups', label: 'Backups', icon: ArchiveIcon, href: tab('backups') },
					{ id: 'pod-logs', label: 'Pod logs', icon: LogsIcon, href: tab('pod-logs') },
					{
						id: 'logs',
						label: 'Logs',
						icon: ScrollTextIcon,
						href: resolve('/(dashboard)/kubernetes/[name]/logs', { name: cluster.name })
					},
					{ id: 'write', label: 'Write config', icon: SparklesIcon, href: tab('write') },
					{ id: 'settings', label: 'Settings', icon: Settings2Icon, href: tab('settings') }
				]
			}
		]
	};
}
