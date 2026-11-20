import type { SteeringDriver } from '@yoal/contracts';
import { HelperVipControl, vipHelperSocketsFromEnv } from './helper-control.ts';
import { createVipDriver as createDriver, vipConfigFromEnv, type VipDriverOptions } from './driver.ts';
import type { SteeringDriverContext } from '../types.ts';

/**
 * The context-only `vip` factory used by the registry: configuration comes from `YOAL_VIP_*`, and
 * the helper transport from `YOAL_VIP_HELPER_SOCKETS`. The core adapter (`core.ts`) replaces this
 * with a settings-backed, sealed configuration when the control plane has a database.
 *
 * A fleet with no reachable helper is refused by preflight with one reason per node; it never
 * pretends to steer a floating address it cannot configure.
 */
export function createVipDriver(context: SteeringDriverContext, overrides: Partial<VipDriverOptions> = {}): SteeringDriver {
	return createDriver(context, {
		config: overrides.config ?? vipConfigFromEnv(),
		control: overrides.control ?? new HelperVipControl({ sockets: vipHelperSocketsFromEnv() }),
		preferredNodeId: overrides.preferredNodeId ?? (process.env.YOAL_VIP_PREFERRED_NODE?.trim() || null),
		addressOf: overrides.addressOf,
	});
}

export {
	VipDriver,
	VIP_BACKUP_PRIORITY,
	VIP_INSTANCE,
	VIP_MASTER_PRIORITY,
	vipConfigFindings,
	vipConfigFromEnv,
	type VipConfig,
	type VipControl,
	type VipControlStatus,
	type VipDriverOptions,
	type VipNodeState,
	type VipReport,
} from './driver.ts';
export { HelperVipControl, vipHelperSocketsFromEnv, type VipHelperControlOptions } from './helper-control.ts';
