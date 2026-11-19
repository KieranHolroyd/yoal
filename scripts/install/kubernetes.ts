/**
 * Install (or remove) the optional Kubernetes node component (docs/KUBERNETES.md §3, K2).
 *
 *   sudo bun scripts/install/kubernetes.ts               # install or refresh
 *   sudo bun scripts/install/kubernetes.ts --no-probe    # skip the tier probe (offers no tier)
 *   sudo bun scripts/install/kubernetes.ts --remove [--purge]
 *
 * The installer runs it with `--with-kubernetes`; the dashboard runs the same code through the
 * helper's `POST /v1/components/kubernetes` verb. Nodes that never install it download nothing.
 */
import {
	installKubernetesComponent,
	kubernetesArch,
	readMarker,
	removeKubernetesComponent,
	type ComponentRunner,
} from '../../apps/helper/src/kubernetes-component.ts';

export { installKubernetesComponent, readMarker, removeKubernetesComponent };

export const spawnComponentRunner: ComponentRunner = {
	async run(argv) {
		const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { code, stdout, stderr };
	},
};

if (import.meta.main) {
	const args = process.argv.slice(2);
	const log = (message: string) => console.log(message);
	if (args.includes('--remove')) {
		await removeKubernetesComponent({ runner: spawnComponentRunner, purge: args.includes('--purge'), log });
		console.log('Kubernetes component removed.');
	} else {
		const arch = kubernetesArch(process.arch);
		if (!arch) {
			console.error(`Unsupported architecture for k3s: ${process.arch}`);
			process.exit(1);
		}
		const report = await installKubernetesComponent({
			runner: spawnComponentRunner,
			arch,
			...(args.includes('--no-probe') ? { probeTiers: [] } : {}),
			log,
		});
		if (report.error) {
			console.error(`Kubernetes component: ${report.error}`);
			process.exit(1);
		}
		console.log(`Kubernetes component ready: minors ${report.minors.join(', ')}; tiers ${report.tiers.join(', ') || 'none'}.`);
	}
}
