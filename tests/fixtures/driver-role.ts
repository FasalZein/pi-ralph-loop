// Hidden driver role for tests: the real managed role with fake pi behind the subprocess seam.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runDriverRole } from "../../src/watch/commands.ts";

const [manifest, scenarioPath, logPath] = process.argv.slice(2);
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => abort.abort());
const fakePi = fileURLToPath(new URL("./fake-pi-rpc.ts", import.meta.url));
const exit = await runDriverRole(manifest, {
	piCommand: { file: process.execPath, args: ["--import", import.meta.resolve("tsx"), fakePi] },
	env: { ...process.env, FAKE_PI_SCENARIO: readFileSync(scenarioPath, "utf8"), FAKE_PI_STDIN_LOG: logPath },
	signal: abort.signal, terminalPollMs: 50, shutdownGraceMs: 500, log: () => {},
});
console.error(`ralph driver: ${exit.reason}${exit.detail ? `: ${exit.detail}` : ""}`);
