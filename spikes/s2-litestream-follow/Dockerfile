# yoal-w0-s2-node: Debian 13 + Bun (the release pin) + the two Litestream builds under test.
#   litestream-0.3.13  the version Yoal pins (packages/contracts/src/platform-config.ts LITESTREAM_VERSION)
#   litestream-0.5.18  the current upstream release (2026-11-03); first with `restore -f` is 0.5.9
# Tarballs are fetched at build time and checked against pinned sha256 (0.3.13 pins copied from
# scripts/platform-config/helper.ts; 0.5.18 from the GitHub release asset digests).
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
ARG TARGETARCH
RUN cat > /tmp/fetch.ts <<'EOF'
import { createHash } from 'node:crypto';
const arch = process.env.TARGETARCH === 'amd64' ? 'amd64' : 'arm64';
const pins = {
	'0.3.13': {
		url: (a: string) => `https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-${a}.tar.gz`,
		sha: { amd64: 'eb75a3de5cab03875cdae9f5f539e6aedadd66607003d9b1e7a9077948818ba0', arm64: '9585f5a508516bd66af2b2376bab4de256a5ef8e2b73ec760559e679628f2d59' },
	},
	'0.5.18': {
		url: (a: string) => `https://github.com/benbjohnson/litestream/releases/download/v0.5.18/litestream-0.5.18-linux-${a === 'amd64' ? 'x86_64' : a}.tar.gz`,
		sha: { amd64: 'd3687b9fd0f2e9426bbd3da828429ff3f1dfc5c9b74d54fdf028e4ee510e7dea', arm64: '922a09e6a7ac67f2095571894dc6382e94e1dd4cdd9674883ddf1a8e74ab982d' },
	},
} as const;
for (const [version, pin] of Object.entries(pins)) {
	const res = await fetch(pin.url(arch));
	if (!res.ok) throw new Error(`${version}: HTTP ${res.status}`);
	const body = new Uint8Array(await res.arrayBuffer());
	const got = createHash('sha256').update(body).digest('hex');
	if (got !== pin.sha[arch]) throw new Error(`${version}: sha256 ${got} != ${pin.sha[arch]}`);
	await Bun.write(`/tmp/ls-${version}.tar.gz`, body);
	console.log(`litestream ${version} ${arch} ok`);
}
EOF
RUN bun /tmp/fetch.ts \
 && for v in 0.3.13 0.5.18; do mkdir -p /tmp/x$v && tar -xzf /tmp/ls-$v.tar.gz -C /tmp/x$v && install -m 0755 /tmp/x$v/litestream /usr/local/bin/litestream-$v; done \
 && rm -rf /tmp/x* /tmp/ls-* /tmp/fetch.ts \
 && litestream-0.3.13 version && litestream-0.5.18 version
COPY writer.ts probe.ts promote.ts /rig/
CMD ["sleep", "infinity"]
