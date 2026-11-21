import type { HaInitApplyView, HaInitPlanView, HaInitRequest, Principal } from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { CoreError } from './errors.ts';

/**
 * `yoal ha init --profile single|ha|ha-dr` (HA-PLAN H27, §8, W14). **Owner: Wave 5 lane B
 * (`ha/w5-b-ha-commands`).** The signatures are final; the bodies are lane B's.
 *
 * - `plan` reads the facts (`HaInitFacts`: the platform store kind, regions with data nodes), calls
 *   the pure `haInitPlan`, diffs its flags against `ctx.config.features` and its settings against
 *   `ClusterConfigService.get()`, and runs the preflight for the profile.
 * - `apply` refuses while a question is unanswered, a running flag differs from the plan (it
 *   returns the `yoal.env` lines; `ha init` never writes a flag, see `ha-init.ts`) or a required
 *   check is not `pass`/`warn`; then writes the cluster settings via `ClusterConfigService.update`
 *   and the profile via `HaService.setProfile`, and audits it.
 * Platform admin only.
 */
export class HaInitService {
	constructor(private readonly ctx: CoreContext) {}

	plan(_principal: Principal, _input: HaInitRequest): HaInitPlanView {
		void this.ctx;
		throw new CoreError('not_built', '`ha init` planning is not built yet (HA-PLAN W14, Wave 5 lane B).', 501);
	}

	async apply(_principal: Principal, _input: HaInitRequest): Promise<HaInitApplyView> {
		throw new CoreError('not_built', '`ha init` is not built yet (HA-PLAN W14, Wave 5 lane B).', 501);
	}
}
