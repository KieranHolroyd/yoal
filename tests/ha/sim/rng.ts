/** A small seeded PRNG (sfc32 seeded through splitmix32), so a seed replays exactly. */
export class Rng {
	#a: number;
	#b: number;
	#c: number;
	#d: number;

	constructor(seed: number, stream = 0) {
		let s = (seed ^ Math.imul(stream + 1, 0x9e3779b9)) >>> 0;
		const next = () => {
			s = (s + 0x9e3779b9) >>> 0;
			let z = s;
			z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
			z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
			return (z ^ (z >>> 16)) >>> 0;
		};
		this.#a = next();
		this.#b = next();
		this.#c = next();
		this.#d = next();
		for (let i = 0; i < 12; i++) this.uint();
	}

	uint(): number {
		const t = (((this.#a + this.#b) >>> 0) + this.#d) >>> 0;
		this.#d = (this.#d + 1) >>> 0;
		this.#a = this.#b ^ (this.#b >>> 9);
		this.#b = (this.#c + (this.#c << 3)) >>> 0;
		this.#c = ((this.#c << 21) | (this.#c >>> 11)) >>> 0;
		this.#c = (this.#c + t) >>> 0;
		return t;
	}

	/** [0, 1) */
	float(): number {
		return this.uint() / 4294967296;
	}

	/** Integer in [min, max]. */
	int(min: number, max: number): number {
		return min + Math.floor(this.float() * (max - min + 1));
	}

	chance(p: number): boolean {
		return this.float() < p;
	}

	pick<T>(items: readonly T[]): T {
		const item = items[Math.floor(this.float() * items.length)];
		if (item === undefined) throw new Error('pick from an empty list');
		return item;
	}

	/** Log-uniform integer in [min, max]: most draws small, a few large. */
	logInt(min: number, max: number): number {
		const lo = Math.log(Math.max(1, min));
		const hi = Math.log(Math.max(1, max));
		return Math.round(Math.exp(lo + this.float() * (hi - lo)));
	}
}

/** FNV-1a over a string, for trace fingerprints. */
export function fnv1a(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}
