/**
 * Builds the prototype forwarders from the repo's own apps/agent/src/endpoints.ts, so the rig
 * always measures the current code. Each replacement must match exactly once, or this fails.
 *
 *   gw.ts     the minimal change H24 needs: each consumer listener also binds the extra addresses
 *             passed as `gatewayBinds` (the node's container gateway addresses).
 *   gw-fix.ts gw.ts plus a fix for a bug the spike found: the signature a listener stores never
 *             equals the one converge() compares, so every converge restarts every listener.
 *
 *   bun make-proto.ts <repo endpoints.ts> <out dir>
 */
const [source, outDir] = process.argv.slice(2) as [string, string];
const original = await Bun.file(source).text();

function replaceOnce(text: string, from: string, to: string): string {
	const count = text.split(from).length - 1;
	if (count !== 1) throw new Error(`expected one match, found ${count}: ${from.slice(0, 60)}`);
	return text.replace(from, to);
}

let gw = original.replace(/from '@yoal\/contracts'/, "from './contracts.ts'");
gw = replaceOnce(gw, 'interface Listener {\n\tserver: Server;', 'interface Listener {\n\tserver: Server;\n\textra?: Server[];');
gw = replaceOnce(
	gw,
	'private readonly certificate?: { certPem: string; keyPem: string };\n',
	'private readonly certificate?: { certPem: string; keyPem: string };\n\tprivate readonly gatewayBinds: string[];\n',
);
gw = replaceOnce(
	gw,
	'constructor(options: { log?: (level: \'info\' | \'warn\', message: string) => void; certificate?: { certPem: string; keyPem: string } } = {}) {',
	'constructor(options: { log?: (level: \'info\' | \'warn\', message: string) => void; certificate?: { certPem: string; keyPem: string }; gatewayBinds?: string[] } = {}) {\n\t\tthis.gatewayBinds = options.gatewayBinds ?? [];',
);
gw = replaceOnce(
	gw,
	"\t\tserver.listen(port, bind);\n\t\treturn { server, signature: `${bind}:${port}->${targetHost}:${targetPort}:${fingerprint ?? 'plain'}` };",
	"\t\tserver.listen(port, bind);\n" +
		"\t\tconst handler = server.listeners('connection')[0] as (socket: Socket) => void;\n" +
		'\t\tconst extra = this.gatewayBinds.map((address) => {\n' +
		'\t\t\tconst more = createServer(handler);\n' +
		"\t\t\tmore.on('error', (error) => this.log('warn', `endpoint ${address}:${port} could not listen: ${error.message}`));\n" +
		'\t\t\tmore.listen(port, address);\n' +
		'\t\t\treturn more;\n' +
		'\t\t});\n' +
		"\t\treturn { server, extra, signature: `${bind}:${port}->${targetHost}:${targetPort}:${fingerprint ?? 'plain'}` };",
);
gw = replaceOnce(
	gw,
	'\t\tlistener.server.close();\n',
	'\t\tlistener.server.close();\n\t\tfor (const more of listener.extra ?? []) more.close();\n',
);
await Bun.write(`${outDir}/gw.ts`, gw);

let fixed = replaceOnce(
	gw,
	"signature: `${bind}:${port}->${targetHost}:${targetPort}:${fingerprint ?? 'plain'}` };",
	'signature: signatureOf(endpoint) };',
);
fixed = replaceOnce(fixed, "return { server, signature: `${bind}:${port}->127.0.0.1:${provider.targetPort}:plain` };", 'return { server, signature: signatureOfProvider(provider) };');
fixed = replaceOnce(
	fixed,
	'return `${endpoint.localPort}->${endpoint.upstream.address ?? \'\'}:${endpoint.upstream.port}`;',
	"return `${endpoint.localPort}->${endpoint.upstream.address ?? ''}:${endpoint.upstream.port}:${endpoint.tlsFingerprint ?? 'plain'}`;",
);
fixed = replaceOnce(
	fixed,
	'\t\treturn {\n\t\t\tserver,\n\t\t\tsignature: `${bind}:${port}->127.0.0.1:${provider.targetPort}:${[...allowed].sort().join(\',\')}`,\n\t\t};',
	'\t\treturn { server, signature: signatureOfProvider(provider) };',
);
await Bun.write(`${outDir}/gw-fix.ts`, fixed);
await Bun.write(
	`${outDir}/contracts.ts`,
	`export interface ServiceEndpoint { id: string; kind: string; serviceId: string; localPort: number; upstream: { nodeId: string; address: string | null; port: number }; tlsFingerprint: string | null }
export interface ServiceProvider { id: string; listenAddress: string; listenPort: number; targetPort: number; allowedClientFingerprints: string[] }
`,
);
console.log(`wrote ${outDir}/gw.ts, ${outDir}/gw-fix.ts`);
