import { enforcerRuntimePath } from "./alert-log.js";

/** Operational files shared with T11's bundle-state-edit exemptions.
 * Item passes, progress and mission policy remain author evidence, not runtime noise.
 */
export function launcherRuntimePath(file: string): boolean {
	return enforcerRuntimePath(file)
		|| ["loop.md", "driver.json", "driver.lock", "launch.lock", "rpc.in", "steer", "watch-host.json"].some(name => file === `.ralph/${name}`)
		|| file.startsWith(".ralph/steer/")
		|| /^\.ralph\/launch-[^/]+\.json(?:\.\d+\.tmp)?$/.test(file)
		|| /^\.ralph\/(?:watch-host|driver)\.json\.\d+\.tmp$/.test(file)
		|| /^\.ralph\/journal(?:\.\d+)?\.jsonl$/.test(file);
}
