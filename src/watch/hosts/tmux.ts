import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { Host, HostHandle, RoleSpec } from "../host.js";

export type TmuxResult = { readonly code: number; readonly stdout: string; readonly stderr: string };
/** Runs `tmux <args>` without a shell; `env` is the complete client environment. */
export type TmuxExec = (args: readonly string[], env: NodeJS.ProcessEnv) => Promise<TmuxResult>;
export type TmuxRuntime = {
	readonly exec?: TmuxExec;
	/** Server selection for new sessions, e.g. `["-L", name]`. Default: the user's default server. */
	readonly server?: readonly string[];
	readonly env?: NodeJS.ProcessEnv;
	readonly now?: () => Date;
};
export const realTmux: TmuxExec = (args, env) => new Promise((resolve) => {
	execFile("tmux", [...args], { env, encoding: "utf8" }, (error, stdout, stderr) => {
		resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
	});
});
const HERDR = /^HERDR_/;
/** Terminal size of the detached session (parity with the old launcher). */
const WIDTH = "220";
const HEIGHT = "50";
/** Holds the pane while options are set; replaced by the role through respawn-pane. */
const BOOTSTRAP = ["sh", "-c", "exec tail -f /dev/null"];

/** Display label: `ralph-<basename>-<root hash>-<launch>`; never used as identity. */
export function sessionName(root: string, launchId: string): string {
	const base = basename(root).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
	return `ralph-${base}-${createHash("sha256").update(root).digest("hex").slice(0, 12)}-${launchId.slice(0, 8)}`;
}

export function tmuxHost(runtime: TmuxRuntime = {}): Host {
	const exec = runtime.exec ?? realTmux;
	// The client never passes herdr variables on; the role additionally unsets server-global ones.
	const clientEnv = Object.fromEntries(Object.entries(runtime.env ?? process.env).filter(([name]) => !HERDR.test(name)));
	const now = runtime.now ?? (() => new Date());
	async function run(args: readonly string[]): Promise<string> {
		const result = await exec(args, clientEnv);
		if (result.code !== 0) throw new Error(`tmux ${args.filter((arg) => !arg.startsWith("/")).slice(0, 3).join(" ")} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
		return result.stdout;
	}
	const at = (handle: HostHandle) => ["-S", handle.socket];
	async function verify(handle: HostHandle): Promise<boolean> {
		const result = await exec([...at(handle), "display-message", "-p", "-t", handle.paneId, "#{session_id}\t#{window_id}\t#{pane_id}\t#{socket_path}\t#{@ralph_root}\t#{@ralph_launch}"], clientEnv);
		return result.code === 0 && result.stdout.replace(/\n$/, "") === [handle.sessionId, handle.windowId, handle.paneId, handle.socket, handle.root, handle.launchId].join("\t");
	}
	return {
		async open(root: string, launchId: string, role: RoleSpec): Promise<HostHandle> {
			const name = sessionName(root, launchId);
			const created = (await run([...(runtime.server ?? []), "new-session", "-d", "-P", "-F", "#{session_id}\t#{window_id}\t#{pane_id}\t#{socket_path}", "-s", name, "-n", role.title, "-c", root, "-x", WIDTH, "-y", HEIGHT, ...BOOTSTRAP])).trim().split("\t");
			if (created.length !== 4 || !created.every(Boolean)) throw new Error("tmux new-session returned no identity");
			const [sessionId, windowId, paneId, socket] = created;
			const handle: HostHandle = { v: 1, kind: "tmux", root, launchId, name, socket, sessionId, windowId, paneId, createdAt: now().toISOString() };
			const target = at(handle);
			await run([...target, "set-option", "-t", sessionId, "@ralph_root", root]);
			await run([...target, "set-option", "-t", sessionId, "@ralph_launch", launchId]);
			// Keep the exited role visible for diagnostics.
			await run([...target, "set-option", "-w", "-t", windowId, "remain-on-exit", "on"]);
			const global = await run([...target, "show-environment", "-g"]);
			const names = new Set([...Object.keys(runtime.env ?? process.env), ...global.split("\n").map((line) => line.replace(/^-/, "").split("=")[0])].filter((variable) => HERDR.test(variable)));
			const argv = ["env", ...[...names].sort().flatMap((variable) => ["-u", variable]), ...Object.entries(role.env).map(([key, value]) => `${key}=${value}`), ...role.argv];
			await run([...target, "respawn-pane", "-k", "-t", paneId, "-c", root, ...argv]);
			return handle;
		},
		verify,
		async paneDead(handle: HostHandle): Promise<boolean> {
			const result = await exec([...at(handle), "display-message", "-p", "-t", handle.paneId, "#{pane_dead}"], clientEnv);
			return result.code !== 0 || result.stdout.trim() === "1";
		},
		async close(handle: HostHandle): Promise<void> {
			if (!await verify(handle)) throw new Error(`tmux session ${handle.sessionId} no longer matches launch ${handle.launchId}`);
			await run([...at(handle), "kill-session", "-t", handle.sessionId]);
		},
	};
}
