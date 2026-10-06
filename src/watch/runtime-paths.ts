import { enforcerRuntimePath } from "./alert-log.js";

// Both launch manifests and steer envelopes use crypto.randomUUID().
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const STEER_FILE = new RegExp(`^\\.ralph/steer/${UUID}\\.txt$`);
const LAUNCH_FILE = new RegExp(`^\\.ralph/launch-${UUID}\\.json(?:\\.\\d+\\.tmp)?$`);

/** Operational files shared with T11's bundle-state-edit exemptions.
 * Item passes, progress and mission policy remain author evidence, not runtime noise.
 */
export function launcherRuntimePath(file: string): boolean {
	return enforcerRuntimePath(file)
		|| ["loop.md", "driver.json", "driver.lock", "launch.lock", "rpc.in", "watch-host.json"].some(name => file === `.ralph/${name}`)
		|| STEER_FILE.test(file)
		|| LAUNCH_FILE.test(file)
		|| /^\.ralph\/(?:watch-host|driver)\.json\.\d+\.tmp$/.test(file)
		|| /^\.ralph\/journal(?:\.\d+)?\.jsonl$/.test(file);
}
