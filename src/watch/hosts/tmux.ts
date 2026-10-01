import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { existsSync } from "node:fs";
import { HOST_CLEANUP_TIMEOUT_MS, type Host, type HostHandle, type RoleSpec } from "../host.js";

export type TmuxResult = { readonly code: number; readonly stdout: string; readonly stderr: string };
/** Runs `tmux <args>` without a shell; `env` is the complete client environment. */
export type TmuxExec = (args: readonly string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<TmuxResult>;
export type TmuxRuntime = {
	readonly exec?: TmuxExec;
	/** Server selection for new sessions, e.g. `["-L", name]`. Default: the user's default server. */
	readonly server?: readonly string[];
	readonly env?: NodeJS.ProcessEnv;
	readonly now?: () => Date;
	/** Cleanup bound; default HOST_CLEANUP_TIMEOUT_MS. */
	readonly cleanupMs?: number;
};
export const realTmux: TmuxExec = (args, env, signal) => new Promise((resolve) => {
	execFile("tmux", [...args], { env, encoding: "utf8", signal }, (error, stdout, stderr) => {
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
	async function run(args: readonly string[], signal?: AbortSignal): Promise<string> {
		if (signal?.aborted) throw signal.reason;
		const result = await exec(args, clientEnv, signal);
		if (signal?.aborted) throw signal.reason;
		if (result.code !== 0) throw new Error(`tmux ${args.filter((arg) => !arg.startsWith("/")).slice(0, 3).join(" ")} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
		return result.stdout;
	}
	const at = (handle: HostHandle) => ["-S", handle.socket];
	const IDENTITY = "#{session_id}\t#{window_id}\t#{pane_id}\t#{socket_path}\t#{@ralph_root}\t#{@ralph_launch}";
	const identity = (handle: HostHandle) => [handle.sessionId, handle.windowId, handle.paneId, handle.socket, handle.root, handle.launchId].join("\t");
	async function verify(handle: HostHandle, signal?: AbortSignal): Promise<boolean> {
		const result = await exec([...at(handle), "display-message", "-p", "-t", handle.paneId, IDENTITY], clientEnv, signal);
		return result.code === 0 && result.stdout.replace(/\n$/, "") === identity(handle);
	}
	const cleanupSignal = () => AbortSignal.timeout(runtime.cleanupMs ?? HOST_CLEANUP_TIMEOUT_MS);
	/**
	 * Remove the session this open created. The role has not dispatched a
	 * launch yet: open never returned, so no caller could release its gate.
	 * Returns a description of what may remain when cleanup cannot finish.
	 */
	async function rollback(handle: HostHandle | null, server: readonly string[], launchId: string): Promise<string | null> {
		const signal = cleanupSignal();
		const kill = async (args: readonly string[], id: string) => {
			const result = await exec([...args, "kill-session", "-t", id], clientEnv, signal);
			return result.code === 0 || signal.aborted ? (signal.aborted ? `tmux session ${id} (launch ${launchId}) may remain: cleanup did not finish` : null) : `tmux session ${id} (launch ${launchId}) may remain: ${result.stderr.trim()}`;
		};
		if (handle) return kill(at(handle), handle.sessionId);
		// Creation identity was not observed (interrupted client): find the session by its unique launch marker.
		const listed = await exec([...server, "list-sessions", "-F", "#{session_id}\t#{@ralph_launch}"], clientEnv, signal);
		if (listed.code !== 0) return signal.aborted ? `a tmux session of launch ${launchId} may remain: cleanup did not finish` : null;
		for (const line of listed.stdout.split("\n")) {
			const [id, marked] = line.split("\t");
			if (id && marked === launchId) { const left = await kill(server, id); if (left) return left; }
		}
		return null;
	}
	return {
		async open(root: string, launchId: string, role: RoleSpec, signal?: AbortSignal): Promise<HostHandle> {
			const name = sessionName(root, launchId);
			const server = runtime.server ?? [];
			// The launch marker is set first in the creating command, so an
			// interrupted creation leaves a session findable by its unique launch id.
			const marked = ["new-session", "-d", "-P", "-F", "#{session_id}\t#{window_id}\t#{pane_id}\t#{socket_path}", "-s", name, "-n", role.title, "-c", root, "-x", WIDTH, "-y", HEIGHT, ...BOOTSTRAP, ";", "set-option", "@ralph_launch", launchId, ";", "set-option", "@ralph_root", root];
			let handle: HostHandle | null = null;
			try {
				if (signal?.aborted) throw signal.reason;
				const result = await exec([...server, ...marked], clientEnv, signal);
				// A failed later command in the chain still printed the creation identity: keep it for rollback.
				const created = result.stdout.trim().split("\n")[0].split("\t");
				if (created.length === 4 && created.every(Boolean)) {
					const [sessionId, windowId, paneId, socket] = created;
					handle = { v: 1, kind: "tmux", root, launchId, name, socket, sessionId, windowId, paneId, createdAt: now().toISOString() };
				}
				if (signal?.aborted) throw signal.reason;
				if (result.code !== 0) throw new Error(`tmux new-session failed: ${result.stderr.trim() || `exit ${result.code}`}`);
				if (!handle) throw new Error("tmux new-session returned no identity");
				const target = at(handle);
				// Keep the exited role visible for diagnostics.
				await run([...target, "set-option", "-w", "-t", handle.windowId, "remain-on-exit", "on"], signal);
				const global = await run([...target, "show-environment", "-g"], signal);
				const names = new Set([...Object.keys(runtime.env ?? process.env), ...global.split("\n").map((line) => line.replace(/^-/, "").split("=")[0])].filter((variable) => HERDR.test(variable)));
				const argv = ["env", ...[...names].sort().flatMap((variable) => ["-u", variable]), ...Object.entries(role.env).map(([key, value]) => `${key}=${value}`), ...role.argv];
				await run([...target, "respawn-pane", "-k", "-t", handle.paneId, "-c", root, ...argv], signal);
				return handle;
			} catch (error) {
				const left = await rollback(handle, server, launchId);
				if (left) throw new Error(`${error instanceof Error ? error.message : String(error)}; ${left}`);
				throw error;
			}
		},
		verify,
		async paneDead(handle: HostHandle, signal?: AbortSignal): Promise<boolean> {
			const uncertain = (detail: string) => new Error(`tmux pane ${handle.paneId} of launch ${handle.launchId}: state uncertain (${detail})`);
			if (signal?.aborted) throw signal.reason;
			// The server's socket is gone: the server and all its panes are gone.
			if (!existsSync(handle.socket)) return true;
			const result = await exec([...at(handle), "display-message", "-p", "-t", handle.paneId, `${IDENTITY}\t#{pane_dead}`], clientEnv, signal);
			if (signal?.aborted) throw signal.reason;
			if (result.code === 0) {
				const line = result.stdout.replace(/\n$/, "");
				if (line === `${identity(handle)}\t1`) return true;
				if (line === `${identity(handle)}\t0`) return false;
				throw uncertain("pane does not match this launch or output is malformed");
			}
			// The query failed: only a server listing without this pane proves absence.
			const panes = await exec([...at(handle), "list-panes", "-a", "-F", "#{pane_id}"], clientEnv, signal);
			if (signal?.aborted) throw signal.reason;
			if (panes.code === 0 && !panes.stdout.split("\n").includes(handle.paneId)) return true;
			throw uncertain(result.stderr.trim() || `exit ${result.code}`);
		},
		async close(handle: HostHandle, signal?: AbortSignal): Promise<void> {
			if (!await verify(handle, signal)) throw new Error(`tmux session ${handle.sessionId} no longer matches launch ${handle.launchId}`);
			await run([...at(handle), "kill-session", "-t", handle.sessionId], signal);
		},
	};
}
