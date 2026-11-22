import * as z from 'zod';
import { assistantGuideSchema, type AssistantGuide, type Principal } from '@yoal/contracts';
import { visibleTools, type YoalToolDefinition } from '../mcp';
import { core } from '../core';
import { handleContainerConsole } from '../container-console';
import { cloudShellConsoleDeps } from '../cloud-shell-console';
import { GUIDE_TOOL } from './constants';
import {
	CLOUD_SHELL_TOOL,
	CLOUD_SHELL_TOOL_DESCRIPTION,
	cloudShellToolSchema,
	runCloudShellCommand
} from './cloud-shell-tool';
import { needsConfirmation, validateToolArgs } from './confirm-policy';
import type { ProviderTool } from './provider';

/**
 * The bridge between Yoal's MCP tool catalog and the assistant's model. Tool names, schemas and
 * behaviour are the MCP ones; only the transport differs. Two tools are assistant-only:
 * `guide_user` drives the dashboard tour, and `run_in_cloud_shell` runs one confirmed command in
 * the person's own cloud shell (D237). MCP clients never get the second.
 */

export interface AssistantTool {
	name: string;
	title: string;
	description: string;
	/**
	 * The chat must stop and ask the user before this tool runs. True for every MCP tool annotated
	 * `destructiveHint` and for every tool in `CONFIRM_TOOLS` (./confirm-policy.ts).
	 */
	destructive: boolean;
	schema: z.ZodType;
	run: (
		args: Record<string, unknown>
	) => Promise<{ ok: boolean; text: string; guide?: AssistantGuide }>;
}

function textResult(value: unknown): string {
	const result = value as {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
	};
	const text = (result?.content ?? [])
		.filter((part) => part?.type === 'text' && typeof part.text === 'string')
		.map((part) => part.text)
		.join('\n');
	if (text) return text;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function summary(text: string, isError: boolean): string {
	const first = text
		.replace(/\s+/g, ' ')
		.replace(/^#+\s*/, '')
		.trim()
		.slice(0, 220);
	if (first) return first;
	return isError ? 'The tool returned an error.' : 'Done.';
}

/**
 * Every permitted MCP tool, plus the UI guide, for one signed-in user. `visibleTools` filters by
 * the principal's compiled grants, read tools included, so the chat offers exactly what MCP offers.
 */
export function assistantTools(principal: Principal): AssistantTool[] {
	const definitions = visibleTools(principal);
	const tools: AssistantTool[] = definitions.map((definition: YoalToolDefinition) => ({
		name: definition.name,
		title: definition.config.title ?? definition.name.replaceAll('_', ' '),
		description: definition.config.description ?? '',
		destructive: needsConfirmation(definition.name, definition.config.annotations),
		schema: definition.config.inputSchema ?? z.object({}),
		run: async (args) => {
			// Model output is untrusted: hold it to the same schema the MCP transport enforces.
			const parsed = validateToolArgs(definition.name, definition.config.inputSchema, args);
			if (!parsed.ok) return { ok: false, text: parsed.error };
			const result = await definition.handler(parsed.args);
			const text = textResult(result);
			const isError = (result as { isError?: boolean })?.isError === true;
			return { ok: !isError, text: text.slice(0, 40_000) };
		}
	}));

	tools.push({
		name: GUIDE_TOOL,
		title: 'Guide the user around the dashboard',
		description:
			'Show a short guided tour: navigate to a path and spotlight an element on the page. Use the target ids and selectors from the page outline in the prompt. Prefer this when the user asks where something is or how to do something in the dashboard.',
		destructive: false,
		schema: assistantGuideSchema,
		run: async (args) => {
			const guide = assistantGuideSchema.parse(args);
			return {
				ok: true,
				text: `The dashboard is showing ${guide.steps.length} guided step${guide.steps.length === 1 ? '' : 's'}. Tell the user what to do in one or two sentences; do not repeat the whole tour in text.`,
				guide
			};
		}
	});

	if (cloudShellToolAvailable(principal))
		tools.push({
			name: CLOUD_SHELL_TOOL,
			title: 'Run a command in your cloud shell',
			description: CLOUD_SHELL_TOOL_DESCRIPTION,
			// Always a Confirm card with the exact command (D237); also listed in CONFIRM_TOOLS.
			destructive: true,
			schema: cloudShellToolSchema,
			run: async (args) => {
				const parsed = validateToolArgs(CLOUD_SHELL_TOOL, cloudShellToolSchema, args);
				if (!parsed.ok) return { ok: false, text: parsed.error };
				const result = await runCloudShellCommand(principal, cloudShellToolSchema.parse(parsed.args), {
					console: (call) => handleContainerConsole(cloudShellConsoleDeps, call),
					shells: core.cloudShells,
					audit: (who, auditArgs, ok) =>
						core.audit.record({
							principal: who,
							action: 'cloud_shell.assistant.run',
							resource: 'cloud_shell',
							args: auditArgs,
							result: ok ? 'ok' : 'error'
						})
				});
				return { ok: result.ok, text: result.text };
			}
		});

	return tools;
}

/**
 * The cloud shell tool is offered to a signed-in person who may use a cloud shell, while the
 * feature is on. The assistant always acts as the dashboard session, never a key or MCP token.
 */
export function cloudShellToolAvailable(principal: Principal): boolean {
	return (
		principal.credential === 'session' &&
		core.cloudShells.enabled() &&
		core.ctx.iam.can(principal, 'cloudShell:use', { type: 'org' })
	);
}

export function toolFor(tools: AssistantTool[], name: string): AssistantTool | undefined {
	return tools.find((tool) => tool.name === name);
}

/** Convert a zod schema to the JSON Schema an OpenAI-compatible provider expects. */
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
	try {
		const json = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
		delete json.$schema;
		return json;
	} catch {
		return { type: 'object', additionalProperties: true };
	}
}

export function providerTools(tools: AssistantTool[]): ProviderTool[] {
	return tools.map((tool) => ({
		type: 'function',
		function: {
			name: tool.name,
			description: tool.description,
			parameters: jsonSchema(tool.schema)
		}
	}));
}

/** Parse a model's JSON arguments; an invalid blob is reported to the model, not thrown. */
export function parseArgs(
	raw: string
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
	try {
		const value = JSON.parse(raw || '{}') as unknown;
		if (!value || typeof value !== 'object' || Array.isArray(value))
			return { ok: false, error: 'Tool arguments must be a JSON object.' };
		return { ok: true, args: value as Record<string, unknown> };
	} catch (error) {
		return { ok: false, error: `Tool arguments were not valid JSON: ${(error as Error).message}` };
	}
}

export function resultSummary(text: string, ok: boolean): string {
	return summary(text, !ok);
}

export type { AssistantGuide };
