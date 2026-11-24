import { permissionCatalog, type Permission, type Principal } from '@yoal/contracts';
import { CoreError } from '../errors.ts';

/**
 * The catalog's `mcp: false` as a check-time rule for one call site (IAM.md, D29/D53).
 *
 * The catalog keeps such permissions off the MCP consent screen, but an MCP principal's grant can
 * still carry one (an owner-role token, a future custom role). Call sites where a model must never
 * act, even when it holds the permission, call this after `iam.require`. Living here keeps
 * principal-kind logic inside the IAM module (`scripts/lint-iam.ts`).
 */
export function refuseIfMcpDenied(principal: Principal, permission: Permission, message: string): void {
	if (principal.kind !== 'mcp') return;
	if (permissionCatalog[permission].mcp) return;
	throw new CoreError('forbidden', message, 403);
}
