import { existsSync } from "node:fs";
import { runEnforcerRole } from "../../src/watch/command-lifecycle.ts";
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => abort.abort());
if (process.argv[3]) while (!existsSync(process.argv[3]) && !abort.signal.aborted) await new Promise(resolve => setTimeout(resolve, 10));
await runEnforcerRole(process.argv[2], { signal: abort.signal, sleep: async (_ms, signal) => {
	if (signal?.aborted) return;
	await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }; const timer = setTimeout(done, 50); signal?.addEventListener("abort", done, { once: true }); });
} });
