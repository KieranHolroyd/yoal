/** In-place sections of a cluster's detail page; logs is its own route. */
export const KUBERNETES_TABS = [
	'overview',
	'access',
	'routes',
	'attachments',
	'backups',
	'pod-logs',
	'write',
	'settings'
] as const;
export type KubernetesTab = (typeof KUBERNETES_TABS)[number];
export const KUBERNETES_DEFAULT_TAB: KubernetesTab = 'overview';
