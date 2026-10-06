import { readGitVersion, type ObservationRuntime } from "./loop-state.js";
import { spawn, type ChildProcess } from "node:child_process";
import { parseImporterOutput, parseMeasureOutput, type EnforcementProbes, type ProbeResult } from "./probes.js";
import type { Mission } from "./types.js";

// Authority: owner on #13, 2026-10-06. No probe timeout; polls never await probes.
export const PROBE_STDOUT_BYTES = 1024 * 1024;
type Task = { readonly version: string; readonly child: ChildProcess; readonly done: Promise<void>; result: ProbeResult<string> | null; running: boolean };
const unavailable = (reason: string): ProbeResult<never> => ({ kind: "unavailable", reason });
/** One in-flight process per argv. A hung probe stays unavailable without blocking observation. */
export function probeRunner(root: string, mission: Mission, runtime: { readonly observation?: ObservationRuntime; readonly signal?: AbortSignal; readonly log?: (message: string) => void } = {}) {
	const abort = new AbortController();
	const signal = runtime.signal ? AbortSignal.any([runtime.signal, abort.signal]) : abort.signal;
	const spawned = new WeakSet<ChildProcess>();
	const terminated = new WeakSet<ChildProcess>();
	const tasks = new Map<string, Task>();
	const activeTasks = new Set<Task>();
	const log = runtime.log ?? console.error;
	/** Termination failures are operational records, never exceptions from stream callbacks. */
	function kill(child: ChildProcess): string | null {
		if (!child.pid || terminated.has(child)) return null;
		if ((child.exitCode !== null || child.signalCode !== null) && child.stdout?.destroyed) return null;
		const direct = (): string | null => {
			try { if (child.kill("SIGKILL")) terminated.add(child); return null; }
			catch (error) { return `probe termination unavailable: ${error instanceof Error ? error.message : String(error)}`; }
		};
		// A detached group may not exist before spawn. Direct-child signalling uses
		// the owned child handle, not a possibly stale or inaccessible group.
		if (!spawned.has(child)) return direct();
		try { process.kill(-child.pid, "SIGKILL"); terminated.add(child); return null; }
		catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ESRCH" || code === "EPERM") {
				if (child.exitCode !== null || child.signalCode !== null) return null;
				return direct();
			}
			return `probe termination unavailable: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	function command(key: string, argv: readonly string[], version: string): ProbeResult<string> {
		let task = tasks.get(key);
		// Consume each completed result once, then refresh even if git did not change:
		// author commands may also read ignored files or other live inputs.
		let completed: ProbeResult<string> | null = null;
		if (task && task.result !== null && !activeTasks.has(task)) {
			if (task.version === version) completed = task.result;
			tasks.delete(key); task = undefined;
		}
		if (!task) {
			const child = spawn(argv[0], [...argv.slice(1)], { cwd: root, shell: false, detached: true, stdio: ["ignore", "pipe", "ignore"] });
			child.once("spawn", () => spawned.add(child));
			const buffers: Buffer[] = []; let size = 0;
			let finish!: () => void;
			task = { version, child, result: null, running: true, done: new Promise<void>(resolve => { finish = resolve; }) };
			tasks.set(key, task); activeTasks.add(task); const active = task;
			child.stdout!.on("data", (buffer: Buffer) => {
				if (active.result) return;
				size += buffer.length;
				if (size > PROBE_STDOUT_BYTES) {
					active.result = unavailable("probe stdout exceeds 1 MiB");
					const failure = kill(child);
					if (failure) { active.result = unavailable(`probe stdout exceeds 1 MiB; ${failure}`); log(failure); }
				}
				else buffers.push(buffer);
			});
			child.on("error", error => { active.result = unavailable(error.message); });
			child.on("close", code => {
				// All inherited output pipes have closed; only completion validation remains.
				active.running = false;
				void (async () => {
					try {
						if (!active.result && code === 0) {
							const endedVersion = await readGitVersion(root, runtime.observation, signal);
							active.result = endedVersion === version ? { kind: "ok", value: Buffer.concat(buffers).toString("utf8") } : unavailable("worktree changed while probe ran");
						} else active.result ??= unavailable(`probe exited ${code}`);
					} catch (error) { active.result = unavailable(error instanceof Error ? error.message : String(error)); }
					finally { activeTasks.delete(active); finish(); }
				})();
			});
		}
		if (completed) return completed;
		if (task.version !== version) return unavailable("probe result belongs to a different worktree version");
		return task.result ?? unavailable("probe still running");
	}
	return {
		read(version: string | null): EnforcementProbes {
			if (version === null) return {};
			const measure = mission.measure ? command("measure", mission.measure.command, version) : null;
			const importers: Record<string, ProbeResult<readonly string[]>> = Object.create(null);
			if (mission.scope.importerCommand) for (const item of mission.scope.items) {
				const result = command(`item:${item.id}`, [...mission.scope.importerCommand, ...item.targets], version);
				importers[item.id] = result.kind === "ok" ? parseImporterOutput(result.value) : result;
			}
			return { ...(measure ? { measure: measure.kind === "ok" ? parseMeasureOutput(measure.value) : measure } : {}), importers };
		},
		async close(): Promise<void> {
			abort.abort(); const pending = [...activeTasks]; const waiting: Promise<void>[] = [];
			for (const task of pending) {
				const failure = task.running ? kill(task.child) : null;
				if (failure) {
					log(failure); task.result = unavailable(failure);
					// A live process we cannot signal needs operator cleanup. Do not let
					// it prevent the enforcer from publishing down and closing its reader.
					task.child.stdout?.destroy(); task.child.unref(); activeTasks.delete(task);
				} else waiting.push(task.done);
			}
			await Promise.all(waiting);
		},
	};
}
