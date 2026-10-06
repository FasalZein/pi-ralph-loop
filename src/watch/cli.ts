import { execute, runDriverRole, runEnforcerRole, type Request } from "./commands.js";

const USAGE = "Usage: ralph launch <root> [--fresh|--relaunch|--resume]\n       ralph stop <root> [--timeout <seconds>]\n       ralph status <root>\n       ralph watch <root>";
type Parsed = { readonly kind: "help" } | { readonly kind: "driver"; readonly manifest: string } | { readonly kind: "enforcer"; readonly manifest: string } | { readonly kind: "watch"; readonly root: string } | { readonly kind: "request"; readonly request: Request };

/** Parse argv; null means a usage error. */
export function parse(argv: readonly string[]): Parsed | null {
	if (argv.length === 0 || (argv.length === 1 && (argv[0] === "-h" || argv[0] === "--help"))) return { kind: "help" };
	const [command, root, ...rest] = argv;
	if (command === "_enforcer") return root && rest.length === 0 && root.startsWith("/") ? { kind: "enforcer", manifest: root } : null;
	if (command === "_driver") return root && rest.length === 0 && root.startsWith("/") ? { kind: "driver", manifest: root } : null;
	if (!root || root.startsWith("-")) return null;
	if (command === "status") return rest.length === 0 ? { kind: "request", request: { kind: "status", root } } : null;
	if (command === "launch") {
		const modes = rest.map((flag) => ({ "--fresh": "fresh", "--relaunch": "relaunch", "--resume": "resume" } as const)[flag as "--fresh"]);
		if (modes.length > 1 || modes.some((mode) => mode === undefined)) return null;
		return { kind: "request", request: { kind: "launch", root, mode: modes[0] ?? "fresh" } };
	}
	if (command === "watch") return rest.length === 0 ? { kind: "watch", root } : null;
	if (command === "stop") {
		if (rest.length === 0) return { kind: "request", request: { kind: "stop", root, timeoutMs: null } };
		const seconds = Number(rest[1]);
		if (rest.length !== 2 || rest[0] !== "--timeout" || !/^\d+(\.\d+)?$/.test(rest[1]) || !(seconds > 0)) return null;
		return { kind: "request", request: { kind: "stop", root, timeoutMs: seconds * 1000 } };
	}
	return null;
}

/** Run the ralph command; resolves to the exit status (0 complete, 1 failure, 2 usage, 3 partial status). */
export async function main(argv: readonly string[]): Promise<number> {
	const parsed = parse(argv);
	if (!parsed) { console.error(USAGE); return 2; }
	if (parsed.kind === "help") { console.log(USAGE); return 0; }
	if (parsed.kind === "enforcer") {
		const abort = new AbortController();
		const stop = () => abort.abort();
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, stop);
		try { const exit = await runEnforcerRole(parsed.manifest, { signal: abort.signal }); return exit.reason === "stopped" ? 0 : 1; }
		finally { for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.removeListener(signal, stop); }
	}
	if (parsed.kind === "driver") {
		const abort = new AbortController();
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => abort.abort());
		const exit = await runDriverRole(parsed.manifest, { signal: abort.signal });
		console.error(`ralph driver: ${exit.reason}${exit.detail ? `: ${exit.detail}` : ""}`);
		return exit.reason === "loop-finished" || exit.reason === "stopped-before-launch" ? 0 : 1;
	}
	if (parsed.kind === "watch") {
		// Loaded here only, so other commands never load pi-tui.
		const { runViewer } = await import("./viewer.js");
		await runViewer({ roots: [parsed.root] });
		return 0;
	}
	const outcome = await execute(parsed.request);
	if (!outcome.ok) { console.error(`ralph: ${outcome.error}`); return 1; }
	if ("status" in outcome) { console.log(outcome.status.text); return outcome.status.exitCode; }
	const { request } = parsed;
	const where = outcome.handle ? ` (tmux session ${outcome.handle.name}, ${outcome.handle.sessionId})` : "";
	console.log(request.kind === "launch" ? `launched ${outcome.handle?.root ?? request.root}${where}` : `stopped ${request.root}${where ? `; closed${where}` : ""}`);
	return 0;
}
