import { ASSISTANT_CLOUD_SHELL_TOOL } from '@yoal/contracts';

/** The assistant-only tool that drives the dashboard tour (not an MCP tool). */
export const GUIDE_TOOL = 'guide_user';

/** The assistant-only tool that loads deferred tool schemas on demand (not an MCP tool). */
export const SEARCH_TOOL = 'search_tools';

/**
 * The assistant-only tool that runs one confirmed command in the person's own cloud shell (D237).
 * Never an MCP tool.
 */
export const CLOUD_SHELL_TOOL = ASSISTANT_CLOUD_SHELL_TOOL;

/** Tools the assistant has that MCP clients never get; MCP has no shell (D127, D237). */
export const ASSISTANT_ONLY_TOOLS: ReadonlySet<string> = new Set([GUIDE_TOOL, SEARCH_TOOL, CLOUD_SHELL_TOOL]);
