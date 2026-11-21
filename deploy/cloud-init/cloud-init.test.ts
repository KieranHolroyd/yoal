import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * Keeps the provisioning templates honest (HA-PLAN H27, W14): they must render as valid
 * cloud-config, and every command line they build must use flags that the installer
 * (scripts/install/USAGE.txt) or /install/node.sh really has. A flag section 8 shows but the
 * installer lacks stays a marked TODO, and this test fails once the installer gains it, so the
 * template gets wired to it.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const usage = read('../../scripts/install/USAGE.txt');
const nodeScript = read('../../apps/control-plane/src/lib/server/install-node.ts');

const templates = {
	first: { file: 'first-machine.yaml.tftpl', script: '/usr/local/sbin/yoal-provision-first' },
	join: { file: 'join-machine.yaml.tftpl', script: '/usr/local/sbin/yoal-provision-join' },
} as const;

const SAMPLE_TOKEN = 'tok_sample_AbCdEf0123456789';

const samples: Record<keyof typeof templates, Record<string, string>> = {
	first: {
		install_url: 'https://raw.githubusercontent.com/KieranHolroyd/yoal/main/install.sh',
		channel: 'stable',
		platform_host: 'control.example.org',
		content_domain: 'apps.example.org',
		acme_email: 'ops@example.org',
		admin_email: '',
		skip_dns_check: 'false',
		features: 'INGRESS_SET,STEERING',
		key_vault_secret_uri: 'https://yoal-kv.vault.azure.net/secrets/cloudflare-dns-token',
		identity_client_id: '00000000-0000-0000-0000-000000000000',
		token_wait_minutes: '30',
		zone: 'uksouth-1',
		roles: 'control,ingress',
	},
	join: {
		control_origin: 'https://control.example.org',
		control_address: '10.40.1.10',
		node_name: 'data-2',
		join_token: SAMPLE_TOKEN,
		endpoint: '10.40.1.12',
		wait_minutes: '45',
		zone: 'uksouth-2',
		roles: 'ingress,compute,data',
	},
};

/**
 * The subset of Terraform's templatefile() the templates may use: `${name}` and the `$${` escape.
 * Directives (`%{ ... }`) are refused so this renderer stays exact.
 */
function render(template: string, vars: Record<string, string>): string {
	if (/(^|[^%])%\{/.test(template)) throw new Error('template directives (%{) are not allowed');
	const missing: string[] = [];
	const out = template.replace(/\$(\$)?\{([^}]*)\}/g, (whole, escape: string | undefined, name: string) => {
		if (escape) return whole.slice(1);
		if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`only plain variables are allowed, got \${${name}}`);
		if (!(name in vars)) missing.push(name);
		return vars[name] ?? '';
	});
	if (missing.length > 0) throw new Error(`no value for ${missing.join(', ')}`);
	return out;
}

function variables(template: string): string[] {
	return [...new Set([...template.matchAll(/(?<!\$)\$\{([a-z_][a-z0-9_]*)\}/g)].map((m) => m[1]!))].sort();
}

interface CloudConfig {
	write_files: Array<{ path: string; permissions: string; owner: string; content: string }>;
	runcmd: unknown[];
}

function parse(kind: keyof typeof templates): { text: string; config: CloudConfig; script: string } {
	const text = render(read(templates[kind].file), samples[kind]);
	const config = Bun.YAML.parse(text) as CloudConfig;
	const script = config.write_files.find((file) => file.path === templates[kind].script)?.content ?? '';
	return { text, config, script };
}

/** Flags on `set --` lines (the argument lists the scripts pass on), comments excluded. */
function flagsPassed(script: string): string[] {
	const flags = new Set<string>();
	for (const raw of script.split('\n')) {
		const line = raw.replace(/#.*$/, '');
		if (!/\bset -- /.test(line) && !/^\s+--/.test(line)) continue;
		for (const match of line.matchAll(/(?:^|\s)(--[a-z][a-z0-9-]*)/g)) flags.add(match[1]!);
	}
	return [...flags].sort();
}

function usageFlags(text: string): Set<string> {
	const flags = new Set<string>();
	for (const line of text.split('\n')) {
		const match = /^ {2}((?:-{1,2}[a-z0-9-]+)(?:, -{1,2}[a-z0-9-]+)*)/.exec(line);
		if (match) for (const flag of match[1]!.split(', ')) flags.add(flag);
	}
	return flags;
}

/** The flags node.sh's own argument loop accepts. */
function nodeScriptFlags(source: string): Set<string> {
	return new Set([...source.matchAll(/^\t\t(--[a-z-]+)\) /gm)].map((m) => m[1]!));
}

describe('cloud-init templates', () => {
	for (const kind of Object.keys(templates) as Array<keyof typeof templates>) {
		test(`${kind}: declares exactly the variables the sample (and Terraform) provide`, () => {
			expect(variables(read(templates[kind].file))).toEqual(Object.keys(samples[kind]).sort());
		});

		test(`${kind}: renders to valid cloud-config with a #cloud-config header`, () => {
			const { text, config, script } = parse(kind);
			expect(text.split('\n')[0]).toBe('#cloud-config');
			expect(Array.isArray(config.write_files)).toBe(true);
			expect(Array.isArray(config.runcmd)).toBe(true);
			expect(script.startsWith('#!/bin/sh\n')).toBe(true);
			const env = config.write_files.find((file) => file.path === '/etc/yoal-provision/provision.env');
			expect(env?.permissions).toBe('0600');
			// Every value lands as one single-quoted shell assignment.
			for (const [name, value] of Object.entries(samples[kind]))
				expect(env?.content).toContain(`${name.toUpperCase()}='${value}'\n`);
		});

		test(`${kind}: the provisioning script is valid POSIX sh`, () => {
			const { script } = parse(kind);
			const result = Bun.spawnSync({ cmd: ['sh', '-n', '/dev/stdin'], stdin: new TextEncoder().encode(script), stderr: 'pipe' });
			expect(new TextDecoder().decode(result.stderr)).toBe('');
			expect(result.exitCode).toBe(0);
		});
	}

	test('first machine: every installer flag it passes is in USAGE.txt', () => {
		const passed = flagsPassed(parse('first').script);
		expect(passed).toEqual(['--acme-email', '--admin-email', '--canary', '--cloudflare-token-file', '--content-domain', '--platform-host', '--skip-dns-check', '--yes']);
		const documented = usageFlags(usage);
		expect(passed.filter((flag) => !documented.has(flag))).toEqual([]);
	});

	test('joining machine: every node.sh flag it passes is one node.sh accepts', () => {
		const passed = flagsPassed(parse('join').script);
		expect(passed).toEqual(['--endpoint', '--name', '--token']);
		const accepted = nodeScriptFlags(nodeScript);
		expect(accepted.size).toBeGreaterThanOrEqual(3);
		expect(passed.filter((flag) => !accepted.has(flag))).toEqual([]);
		// node.sh is fetched from the control plane, the same line Nodes > Enroll node prints.
		expect(parse('join').script).toContain('"$CONTROL_ORIGIN/install/node.sh"');
	});

	test('section 8 flags the installer lacks are marked TODO, and still lacking', () => {
		const documented = usageFlags(usage);
		const first = read(templates.first.file);
		const join = read(templates.join.file);
		for (const flag of ['--profile', '--zone', '--roles']) {
			// If this fails, the installer gained the flag: pass it from the template and drop the TODO.
			expect(documented.has(flag)).toBe(false);
			expect(first).toContain(`TODO(installer): ${flag} `);
		}
		for (const flag of ['--zone', '--roles']) {
			expect(nodeScriptFlags(nodeScript).has(flag)).toBe(false);
			expect(join).toContain(`TODO(installer): ${flag} `);
		}
		// --object-store exists but only takes local|r2; azure:// is section 8's shape.
		expect(usage).toContain('--object-store local|r2 ');
		expect(first).toContain('TODO(installer): --object-store azure://');
	});

	test('no secret is baked into a template', () => {
		for (const { file } of Object.values(templates)) {
			const text = read(file);
			expect(text).not.toContain(SAMPLE_TOKEN);
			// Secret-bearing values only ever arrive as variables.
			expect(text).not.toMatch(/--token\s+[A-Za-z0-9_]{16,}/);
			expect(text).not.toMatch(/(?:R2_SECRET_ACCESS_KEY|YOAL_AZURE_ACCOUNT_KEY|YOAL_AZURE_SAS_TOKEN)=/);
		}
		// The rendered join token appears once (provision.env) and the script clears it afterwards.
		const { text, script } = parse('join');
		expect(text.split(SAMPLE_TOKEN).length - 1).toBe(1);
		expect(script).toContain("JOIN_TOKEN=''");
	});

	test('every Terraform module passes exactly the template variables', () => {
		for (const cloud of ['azure', 'hetzner', 'aws']) {
			const source = read(`../terraform/${cloud}/main.tf`);
			for (const [kind, { file }] of Object.entries(templates) as Array<[keyof typeof templates, { file: string }]>) {
				const call = new RegExp(`templatefile\\(\\s*"[^"]*${file.replace('.', '\\.')}",\\s*\\{([\\s\\S]*?)\\n\\s*\\}\\)`).exec(source);
				expect(call, `${cloud} renders ${file}`).not.toBeNull();
				const keys = [...call![1]!.matchAll(/^\s*([a-z_][a-z0-9_]*)\s*=/gm)].map((m) => m[1]!).sort();
				expect(keys, `${cloud} → ${file}`).toEqual(Object.keys(samples[kind]).sort());
			}
		}
	});
});
