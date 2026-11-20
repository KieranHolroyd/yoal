/** Lab topology: one bridge segment, every name `yoal-w0-s9-*`, no published host ports. */
const NET = '172.31.209';

export const LAB = {
	network: 'yoal-w0-s9-net',
	subnet: `${NET}.0/24`,
	domain: 's9.test',
	healthPort: 8099,
	vip: `${NET}.100`,
	vrrpPass: 's9lab',
	haproxy: { name: 'yoal-w0-s9-haproxy', ip: `${NET}.10` },
	ingress: [
		{ name: 'ing-a', container: 'yoal-w0-s9-ing-a', ip: `${NET}.21` },
		{ name: 'ing-b', container: 'yoal-w0-s9-ing-b', ip: `${NET}.22` },
		{ name: 'ing-c', container: 'yoal-w0-s9-ing-c', ip: `${NET}.23` },
	],
	apps: [
		{ name: 'app1', container: 'yoal-w0-s9-app1', ip: `${NET}.31` },
		{ name: 'app2', container: 'yoal-w0-s9-app2', ip: `${NET}.32` },
	],
	client: { name: 'yoal-w0-s9-client', ip: `${NET}.50` },
	attacker: { name: 'yoal-w0-s9-attacker', ip: `${NET}.66` },
	images: {
		ingress: 'yoal-w0-s9-ingress:2.11.8',
		haproxy: 'haproxy:3.4.8-alpine',
		bun: 'oven/bun:1.4.4-alpine',
	},
} as const;
