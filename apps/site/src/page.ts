/**
 * Yoal's public front page. One static HTML document built from template strings; the only
 * script is a few lines for the copy buttons. Every claim here should match the README and
 * docs/: if a feature is behind a flag or still in preview, say so.
 */

export interface PageContext {
	assets: { css: string; favicon: string; fonts: string[] };
	version: string;
	repoUrl: string;
	docsUrl: string;
	/** Absolute public URL of this page, for canonical and Open Graph tags. */
	siteUrl: string | null;
	/** Number of MCP tools, shown in the agents section. */
	toolCount: number;
}

export function esc(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

const LOGO =
	'<svg class="logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#1b2235"/><g fill="none" stroke="#f0743a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 6.5v10"/><path d="M16 7.5 9.5 16.5H16"/></g><path d="M5.5 20h21l-3.2 5.2H8.7Z" fill="#eef1f7"/></svg>';

const I = (body: string) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;

const ICON = {
	github: I(
		'<path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>'
	),
	arrow: I('<path d="M5 12h14M13 6l6 6-6 6"/>'),
	copy: I('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
	check: I('<path d="m5 12 5 5 9-10"/>'),
	home: I('<path d="M4 11 12 4l8 7"/><path d="M6 9.5V20h12V9.5"/>'),
	feather: I('<path d="M20 4C10 4 6 10 6 18"/><path d="M6 18h6c4 0 8-6 8-14"/><path d="M4 20l2-2"/>'),
	layers: I('<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>'),
	bot: I('<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13v1M15 13v1"/>'),
	split: I('<circle cx="12" cy="5" r="2"/><path d="M12 7v4M5 19v-4h14v4M12 11v8"/>'),
	pulse: I('<path d="M3 12h4l3-7 4 14 3-7h4"/>'),
	globe: I('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>'),
	bolt: I('<path d="M13 3 5 14h6l-1 7 8-11h-6l1-7Z"/>'),
	box: I('<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>'),
	db: I('<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>'),
	bucket: I('<path d="M4 7h16l-1.5 12.5a2 2 0 0 1-2 1.5h-9a2 2 0 0 1-2-1.5L4 7Z"/><path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3"/>'),
	queue: I('<rect x="3" y="5" width="5" height="14" rx="1.5"/><rect x="10" y="5" width="5" height="14" rx="1.5"/><path d="M17 12h4M19 10l2 2-2 2"/>'),
	mail: I('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>'),
	shield: I('<path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/>'),
	key: I('<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3"/>'),
	lock: I('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
	eye: I('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'),
	bell: I('<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2Z"/><path d="M10 21h4"/>'),
	undo: I('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>')
};

function copyBlock(command: string, label: string): string {
	return `<div class="cmd">
	<pre><code>${esc(command)}</code></pre>
	<button type="button" class="copy" data-copy="${esc(command)}" aria-label="Copy ${esc(label)}">${ICON.copy}<span class="sr-only">Copy</span></button>
</div>`;
}

function hero(ctx: PageContext): string {
	return `<section class="hero">
	<div class="hero-sea" aria-hidden="true">
		<svg viewBox="0 0 1200 160" preserveAspectRatio="none"><path d="M0 70c120-28 220-28 340 0s220 28 340 0 220-28 340 0 140 22 180 10v80H0Z"/><path d="M0 104c140-24 260-24 400 0s260 24 400 0 260-24 400 0v56H0Z"/></svg>
	</div>
	<div class="wrap hero-grid">
		<div class="hero-copy">
			<a class="pill" href="${esc(ctx.repoUrl)}" target="_blank" rel="noopener noreferrer"><span class="dot"></span>Open source · MIT · v${esc(ctx.version)}</a>
			<h1>Your own <span class="accent">little cloud.</span></h1>
			<p class="lead">Yoal is a lightweight, self-hosted deploy platform for one VPS and a few nodes. Ship sites, functions, apps and databases to your own domain from a CLI, a dashboard, or your AI agent.</p>
			<div class="actions">
				<a class="btn primary" href="#install">Install on your server ${ICON.arrow}</a>
				<a class="btn ghost" href="${esc(ctx.docsUrl)}">Read the docs</a>
			</div>
			<ul class="hero-facts">
				<li>Bun, SQLite and Caddy</li>
				<li>No Kubernetes</li>
				<li>Agent-native over MCP</li>
			</ul>
		</div>
		<div class="console" role="region" aria-label="Example: deploying with Yoal">
			<div class="console-bar">
				<span class="lights" aria-hidden="true"><i></i><i></i><i></i></span>
				<div class="tabs">
					<input type="radio" name="console" id="tab-agent" checked>
					<label for="tab-agent">Your agent</label>
					<input type="radio" name="console" id="tab-cli">
					<label for="tab-cli">CLI</label>
					<div class="panes">
						<div class="pane pane-agent">
							<p class="chat-you"><span>You</span>Deploy <code>./dist</code> as <code>launch-page</code>, and give me a share link that expires on Friday.</p>
							<ol class="calls">
								<li><span class="ok">${ICON.check}</span><code>deploy_site</code><em>launch-page · 214 files · 1.8 MB</em></li>
								<li><span class="ok">${ICON.check}</span><code>create_share_link</code><em>expires Fri 18:00</em></li>
							</ol>
							<p class="chat-agent"><span>Agent</span>Done. Preview is live at <code>launch-page--k3f9a.example.com</code> and here's your share link. The audit log records the deploy as <code>mcp.deploy_site</code>.</p>
						</div>
						<div class="pane pane-cli">
<pre><span class="p">$</span> yoal deploy ./dist
<span class="m">  packing</span>   214 files, 1.8 MB
<span class="m">  release</span>   sha256:9c1e…4b07
<span class="m">  preview</span>   https://launch-page--k3f9a.example.com
<span class="m">  promote</span>   production → k3f9a  <span class="g">✓ 41 ms</span>

<span class="p">$</span> yoal rollback launch-page
<span class="m">  promote</span>   production → p7d2c  <span class="g">✓ 38 ms</span></pre>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
</section>`;
}

function why(): string {
	const items: [string, string, string][] = [
		[
			ICON.home,
			'Yours',
			'One Debian or Ubuntu VPS, your domain, your object store. No per-seat pricing, no lock-in, and if the control plane goes down your sites keep serving.'
		],
		[
			ICON.feather,
			'Small',
			'Bun, SQLite and Caddy, plus optional ClickHouse for telemetry. No Kubernetes, no Docker requirement, no external database. It fits on a small VPS.'
		],
		[
			ICON.layers,
			'Immutable',
			'Every deploy is a content-addressed release with its own preview URL. Promote and rollback move a pointer, so they finish almost instantly and can’t half-apply.'
		],
		[
			ICON.bot,
			'Agent-native',
			'A full MCP server with OAuth 2.1, consent with permission subsets and human confirmation before destructive actions. Agents get exactly what their token allows.'
		],
		[
			ICON.split,
			'One brain, five surfaces',
			'Dashboard, assistant, REST API, MCP server and CLI all call the same service layer. No surface can do more than another, and every action is audited the same way.'
		],
		[
			ICON.pulse,
			'Operable',
			'Prometheus metrics, traffic and error telemetry, alerts, Litestream backups with a monthly restore drill, and self-update with rollback from the dashboard.'
		]
	];
	return `<section class="section" id="why">
	<div class="wrap">
		<header class="section-head">
			<p class="eyebrow">Why Yoal</p>
			<h2>The deploy experience of a big platform, on hardware you own.</h2>
		</header>
		<div class="why-grid">
${items
	.map(
		([icon, title, body]) => `			<article class="why">
				<span class="why-icon">${icon}</span>
				<h3>${title}</h3>
				<p>${body}</p>
			</article>`
	)
	.join('\n')}
		</div>
	</div>
</section>`;
}

function releases(): string {
	const rows: [string, string, string, string][] = [
		['k3f9a', 'sha256:9c1e…4b07', '2 min ago', 'production'],
		['p7d2c', 'sha256:51aa…e9c2', 'yesterday', ''],
		['b02mx', 'sha256:e470…13fd', '3 days ago', '']
	];
	return `<section class="section alt" id="deploys">
	<div class="wrap split">
		<div>
			<p class="eyebrow">Deploys</p>
			<h2>Every deploy gets a URL. Production is just a pointer.</h2>
			<p class="body">Upload a folder and Yoal stores it as an immutable release, keyed by its hash, with a permanent preview at <code>&lt;slug&gt;--&lt;id&gt;.yourdomain</code>. Promoting moves the production pointer and swaps a symlink. Rolling back does the same in reverse.</p>
			<ul class="ticks">
				<li>${ICON.check}<span><code>_redirects</code>, <code>_headers</code> and <code>yoal.json</code> compile to Caddy routes</span></li>
				<li>${ICON.check}<span>Precompressed <code>br</code> and <code>gzip</code>, SPA mode, custom 404s</span></li>
				<li>${ICON.check}<span>Public, password or platform-login access, plus share links you can revoke instantly</span></li>
				<li>${ICON.check}<span>Wildcard TLS via DNS-01, so new subdomains need no DNS changes or new certs</span></li>
			</ul>
		</div>
		<div class="releases" aria-label="Example deployment list">
			<div class="releases-head"><span>launch-page</span><span class="muted">Deployments</span></div>
			<ol>
${rows
	.map(
		([id, sha, when, tag]) => `				<li class="${tag ? 'live' : ''}">
					<span class="rel-id">${id}</span>
					<span class="rel-sha">${sha}</span>
					<span class="rel-when">${when}</span>
					${tag ? `<span class="badge">${tag}</span>` : `<span class="rel-action">${ICON.undo} Promote</span>`}
				</li>`
	)
	.join('\n')}
			</ol>
			<p class="releases-foot"><span class="g">●</span> launch-page.example.com → k3f9a</p>
		</div>
	</div>
</section>`;
}

function agents(ctx: PageContext): string {
	const areas = [
		'Projects',
		'Deploy',
		'Releases',
		'Environments',
		'Functions',
		'Volumes',
		'Databases',
		'Backups',
		'Queues',
		'Event rules',
		'Storage',
		'Access',
		'Logs',
		'Dashboards',
		'Alerts',
		'Email',
		'Platform'
	];
	return `<section class="section dark" id="agents">
	<div class="wrap split reverse">
		<div>
			<p class="eyebrow">For agents</p>
			<h2>Ask your agent to deploy a website, and it does.</h2>
			<p class="body">Point any MCP client at your control plane. It finds the authorization server by itself, you approve it on a consent screen, and you choose which permissions it gets. ${ctx.toolCount} tools cover the whole platform, each a thin wrapper over the same call the dashboard makes.</p>
			<ul class="ticks">
				<li>${ICON.check}<span>OAuth 2.1 with CIMD and DCR, PKCE and scope step-up</span></li>
				<li>${ICON.check}<span>Deletes wait for a human to confirm, in the client or the dashboard</span></li>
				<li>${ICON.check}<span>A token can do at most what its scopes <em>and</em> your current role allow</span></li>
				<li>${ICON.check}<span>Every call lands in the audit log as <code>mcp.&lt;tool&gt;</code>, denied ones too</span></li>
			</ul>
		</div>
		<div class="agent-card">
			<p class="card-label">Connect Claude Code</p>
			${copyBlock('claude mcp add --transport http yoal https://control.example.com/mcp', 'MCP command')}
			<p class="card-label">What it can reach</p>
			<ul class="chips">${areas.map((area) => `<li>${area}</li>`).join('')}</ul>
			<p class="card-note">Prefer to stay in the browser? The optional in-dashboard assistant uses the same tools with any OpenAI-compatible model, and holds destructive actions for your click.</p>
		</div>
	</div>
</section>`;
}

function platform(): string {
	const items: [string, string, string, string?][] = [
		[ICON.globe, 'Static sites', 'Preview URLs, promote and rollback, access control and share links.'],
		[ICON.bolt, 'Functions', 'Workers-compatible functions on pinned workerd, with cron triggers. No Wrangler needed.'],
		[ICON.box, 'Apps and containers', 'Sandboxed systemd process apps, Podman containers, git builds and custom domains.', 'Preview'],
		[ICON.db, 'Databases', 'Postgres 16 to 18, MySQL, MariaDB, MongoDB, Valkey, Redis and ClickHouse, with backups and a built-in studio.'],
		[ICON.bucket, 'Object storage', 'S3-compatible buckets with scoped credentials, usage charts and soft delete.'],
		[ICON.queue, 'Queues', 'Managed NATS JetStream with peek, send, redrive and event rules.'],
		[ICON.mail, 'Email', 'Outbound mail from your verified domains through Yoal’s own MTA, with DKIM.'],
		[ICON.eye, 'Errors and telemetry', 'Sentry-compatible error tracking, traffic, logs and custom dashboards.']
	];
	return `<section class="section" id="platform">
	<div class="wrap">
		<header class="section-head">
			<p class="eyebrow">What you can run</p>
			<h2>Start with a static site. Grow into a small cloud.</h2>
			<p class="body">Managed services are attached to projects with scoped credentials, and Yoal suggests the environment variables from your <code>.env</code> and code.</p>
		</header>
		<div class="platform-grid">
${items
	.map(
		([icon, title, body, tag]) => `			<article class="tile">
				<div class="tile-top"><span class="tile-icon">${icon}</span>${tag ? `<span class="tag">${tag}</span>` : ''}</div>
				<h3>${title}</h3>
				<p>${body}</p>
			</article>`
	)
	.join('\n')}
		</div>
	</div>
</section>`;
}

function operate(): string {
	const items: [string, string, string][] = [
		[ICON.bell, 'Alerts that reach you', 'Offline nodes, disk, certificates, backups and 5xx spikes after a promote, sent by email, webhook, Discord, Slack, Telegram, ntfy, SMS or Web Push.'],
		[ICON.undo, 'Recovery you have rehearsed', 'Litestream backups to R2, a scripted restore, a monthly restore drill and an encrypted recovery kit.'],
		[ICON.layers, 'Updates that roll back', 'Signed releases, stable and canary channels, and an atomic release switch that rolls itself back if a health check fails.'],
		[ICON.split, 'More than one machine', 'Node agents reconcile desired state over WireGuard. If a worker goes down, its sites answer with a branded 503 and Retry-After.']
	];
	return `<section class="section alt" id="operate">
	<div class="wrap">
		<header class="section-head">
			<p class="eyebrow">Day two</p>
			<h2>Built to be run by one person.</h2>
		</header>
		<div class="op-grid">
${items
	.map(
		([icon, title, body]) => `			<article class="op">
				<span class="why-icon">${icon}</span>
				<div><h3>${title}</h3><p>${body}</p></div>
			</article>`
	)
	.join('\n')}
		</div>
	</div>
</section>`;
}

function install(ctx: PageContext): string {
	return `<section class="section" id="install">
	<div class="wrap">
		<header class="section-head">
			<p class="eyebrow">Get started</p>
			<h2>Three commands from a fresh VPS to a live site.</h2>
		</header>
		<ol class="steps">
			<li class="step">
				<span class="step-n">1</span>
				<div class="step-body">
					<h3>Install the platform</h3>
					<p>On Debian or Ubuntu with Caddy installed. The installer checks the host, lays out users and secrets, and rolls back if anything fails. Add <code>--dry-run</code> to see the plan first.</p>
					${copyBlock(`curl -fsSL https://raw.githubusercontent.com/KieranHolroyd/yoal/main/install.sh | sudo sh`, 'install command')}
				</div>
			</li>
			<li class="step">
				<span class="step-n">2</span>
				<div class="step-body">
					<h3>Log in from your machine</h3>
					<p>Approve the CLI in your browser. For CI, use an API key instead.</p>
					${copyBlock(`npm install -g @yoal/cli && yoal login --url https://control.example.com`, 'login command')}
				</div>
			</li>
			<li class="step">
				<span class="step-n">3</span>
				<div class="step-body">
					<h3>Deploy</h3>
					<p>Yoal zips the folder, uploads it and promotes it. Your site is live at <code>&lt;project&gt;.yourdomain</code>.</p>
					${copyBlock(`yoal deploy ./dist`, 'deploy command')}
				</div>
			</li>
		</ol>
		<p class="install-foot">Want every build as it lands? Install from the canary channel with <code>sh -s -- --canary</code>. The full runbook is in the <a href="${esc(ctx.docsUrl)}">docs</a>.</p>
	</div>
</section>`;
}

function security(): string {
	const items: [string, string, string][] = [
		[ICON.split, 'One service layer', 'Every surface goes through the same core, so none can bypass a check another enforces.'],
		[ICON.key, 'Tokens narrow with roles', 'Demote someone and every token they issued narrows straight away.'],
		[ICON.globe, 'Two domains', 'Deployed content lives on its own domain, so platform cookies never reach it.'],
		[ICON.lock, 'Sealed secrets', 'Envelope encryption under a master key sealed to the machine with systemd-creds. Secrets can’t be read back through the API.']
	];
	return `<section class="section" id="security">
	<div class="wrap">
		<header class="section-head">
			<p class="eyebrow">Security model</p>
			<h2>Deployed content is untrusted. The platform acts like it.</h2>
		</header>
		<div class="sec-grid">
${items
	.map(
		([icon, title, body]) => `			<article class="sec">
				<span class="sec-icon">${icon}</span>
				<h3>${title}</h3>
				<p>${body}</p>
			</article>`
	)
	.join('\n')}
		</div>
	</div>
</section>`;
}

function closing(ctx: PageContext): string {
	return `<section class="closing">
	<div class="wrap closing-inner">
		${LOGO}
		<h2>Set sail on your own server.</h2>
		<p>Yoal is newly open source and still early. Expect rough edges and breaking changes before 1.0. Issues and pull requests are welcome.</p>
		<div class="actions center">
			<a class="btn primary" href="#install">Install Yoal ${ICON.arrow}</a>
			<a class="btn ghost" href="${esc(ctx.repoUrl)}" target="_blank" rel="noopener noreferrer">${ICON.github} Star on GitHub</a>
		</div>
	</div>
</section>`;
}

const COPY_SCRIPT = `document.addEventListener('click',function(e){var b=e.target.closest('[data-copy]');if(!b)return;navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function(){b.classList.add('done');setTimeout(function(){b.classList.remove('done')},1600)})});`;

export function renderPage(ctx: PageContext): string {
	const title = 'Yoal: your own little cloud';
	const description =
		'Yoal is a lightweight, self-hosted deploy platform. Ship sites, functions, apps and databases to your own servers from a CLI, a dashboard, or your AI agent.';
	return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#1b2235">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
${ctx.siteUrl ? `<link rel="canonical" href="${esc(ctx.siteUrl)}">\n<meta property="og:url" content="${esc(ctx.siteUrl)}">\n` : ''}<link rel="icon" href="${ctx.assets.favicon}" type="image/svg+xml">
${ctx.assets.fonts.map((font) => `<link rel="preload" href="${font}" as="font" type="font/woff2" crossorigin>`).join('\n')}
<link rel="stylesheet" href="${ctx.assets.css}">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="nav">
	<div class="wrap nav-inner">
		<a class="brand" href="#top" aria-label="Yoal home">${LOGO}<span>Yoal</span></a>
		<nav aria-label="Sections">
			<a href="#why">Why</a>
			<a href="#agents">Agents</a>
			<a href="#platform">Platform</a>
			<a href="#install">Install</a>
			<a href="${esc(ctx.docsUrl)}">Docs</a>
		</nav>
		<a class="nav-gh" href="${esc(ctx.repoUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Yoal on GitHub">${ICON.github}<span>GitHub</span></a>
	</div>
</header>
<main id="main">
<span id="top"></span>
${hero(ctx)}
${why()}
${releases()}
${agents(ctx)}
${platform()}
${operate()}
${install(ctx)}
${security()}
${closing(ctx)}
</main>
<footer class="footer">
	<div class="wrap footer-inner">
		<a class="brand" href="#top">${LOGO}<span>Yoal</span></a>
		<p>MIT licensed. v${esc(ctx.version)}.</p>
		<nav aria-label="Footer">
			<a href="${esc(ctx.docsUrl)}">Docs</a>
			<a href="${esc(ctx.repoUrl)}" target="_blank" rel="noopener noreferrer">GitHub</a>
			<a href="https://www.npmjs.com/package/@yoal/cli" target="_blank" rel="noopener noreferrer">npm</a>
			<a href="${esc(ctx.repoUrl)}/security/advisories/new" target="_blank" rel="noopener noreferrer">Report a vulnerability</a>
		</nav>
	</div>
</footer>
<script>${COPY_SCRIPT}</script>
</body>
</html>
`;
}
