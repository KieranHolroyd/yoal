/** Address arithmetic for lab faults (IPv4 only, like the helper's fault verbs). */

function ipToInt(address: string): number {
	return address.split('.').reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}
function intToIp(value: number): string {
	return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}
/** `network` minus single addresses, as the fewest CIDRs (≤ 32 − prefix per excluded address). */
export function cidrComplement(network: string, exclude: string[]): string[] {
	const [base, bits] = network.split('/');
	const excluded = exclude.map(ipToInt);
	const out: string[] = [];
	const cover = (start: number, prefix: number) => {
		const size = 2 ** (32 - prefix);
		const inside = excluded.filter((address) => address >= start && address < start + size);
		if (inside.length === 0) out.push(`${intToIp(start)}/${prefix}`);
		else if (prefix < 32) {
			cover(start, prefix + 1);
			cover(start + size / 2, prefix + 1);
		}
	};
	cover(ipToInt(base!), Number(bits));
	return out;
}
