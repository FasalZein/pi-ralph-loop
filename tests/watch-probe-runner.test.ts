import assert from "node:assert/strict";
import test from "node:test";
import { readGitVersion } from "../src/watch/loop-state.ts";
import { loadMission } from "../src/watch/config.ts";
import { probeRunner } from "../src/watch/probe-runner.ts";
import { Fixture } from "./fixtures/loop-state.ts";

const wait = () => new Promise(r => setTimeout(r, 20));
test("probes run argv, parse measure and per-item importers; incomplete runs stay unavailable", async () => {
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: false }], { extra: {
		measure: { command: [process.execPath, "-e", 'console.log(JSON.stringify({debt:1}))'], start: { debt: 0 } },
		scope: { importerCommand: [process.execPath, "-e", "console.log(JSON.stringify(process.argv.slice(1)))"], items: [{ id: "A", targets: ["src/a.ts"], allowedPaths: ["src"] }, { id: "B", targets: ["src/b.ts"], allowedPaths: ["src"] }] },
	} });
	const version = await readGitVersion(f.root);
	const runner = probeRunner(f.root, await loadMission(f.root));
	try {
		assert.equal(runner.read(version).measure?.kind, "unavailable");
		let measure: ReturnType<typeof runner.read>["measure"];
		let a: NonNullable<ReturnType<typeof runner.read>["importers"]>[string] | undefined;
		let b: NonNullable<ReturnType<typeof runner.read>["importers"]>[string] | undefined;
		for (let n = 0; n < 100 && (!measure || !a || !b); n++) {
			await wait(); const result = runner.read(version);
			if (result.measure?.kind === "ok") measure = result.measure;
			if (result.importers?.A.kind === "ok") a = result.importers.A;
			if (result.importers?.B.kind === "ok") b = result.importers.B;
		}
		assert.deepEqual(measure, { kind: "ok", value: { debt: 1 } });
		assert.deepEqual(a, { kind: "ok", value: ["src/a.ts"] });
		assert.deepEqual(b, { kind: "ok", value: ["src/b.ts"] });
		assert.equal(runner.read("two").measure?.kind, "unavailable");
	} finally { await runner.close(); f.close(); }
});
for (const [name, code, reason] of [
	["bad JSON", 'console.log("bad")', /JSON|Unexpected/],
	["nonzero exit", 'process.exit(7)', /exited 7/],
	["stdout cap", 'process.stdout.write("x".repeat(1024*1024+1))', /exceeds 1 MiB/],
] as const) test(`probe ${name} is unavailable`, async () => {
	const f = new Fixture([], { plain: true, extra: { measure: { command: [process.execPath, "-e", code], start: {} } } });
	const version = await readGitVersion(f.root);
	const runner = probeRunner(f.root, await loadMission(f.root));
	try {
		runner.read(version); let result;
		for (let n = 0; n < 100; n++) { await wait(); result = runner.read(version).measure; if (result?.kind === "unavailable" && result.reason !== "probe still running") break; }
		assert.ok(result?.kind === "unavailable"); assert.match(result.reason, reason);
	} finally { await runner.close(); f.close(); }
});

test("hung probes never block reads and shutdown reaps their process groups", async () => {
	const f = new Fixture([], { plain: true, extra: { measure: { command: [process.execPath, "-e", "setInterval(()=>{},1000)"], start: {} } } });
	const version = await readGitVersion(f.root);
	const runner = probeRunner(f.root, await loadMission(f.root));
	try { for (let n = 0; n < 10; n++) assert.equal(runner.read(version).measure?.kind, "unavailable"); }
	finally { await runner.close(); f.close(); }
});

test("a probe's worktree edit invalidates its output at completion", async () => {
	const { writeFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const f = new Fixture([], { plain: true, extra: { measure: { command: [process.execPath, "-e", 'require("node:fs").writeFileSync("changing.ts","const changed = 1;\\n"); console.log("{\\"debt\\":1}")'], start: { debt: 0 } } } });
	const full = join(f.root, "changing.ts");
	writeFileSync(full, "const original = 1;\n"); f.git("add", "changing.ts"); f.git("commit", "-qm", "original");
	const version = await readGitVersion(f.root);
	const runner = probeRunner(f.root, await loadMission(f.root));
	try {
		runner.read(version); let result;
		for (let n = 0; n < 100; n++) { await wait(); result = runner.read(version).measure; if (result?.kind === "unavailable" && result.reason.includes("worktree changed")) break; }
		assert.ok(result?.kind === "unavailable"); assert.match(result.reason, /worktree changed/);
		writeFileSync(full, "const original = 1;\n");
		assert.equal(await readGitVersion(f.root), version);
	} finally { await runner.close(); f.close(); }
});
