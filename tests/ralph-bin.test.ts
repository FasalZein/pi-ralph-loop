import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Fixture, T } from "./fixtures/loop-state.ts";

const bin = fileURLToPath(new URL("../src/watch/ralph.mjs", import.meta.url));
const require = createRequire(import.meta.url);

function fakePi(t: test.TestContext, omit?: "jiti" | "pi-tui"): string {
	const root = mkdtempSync(join(tmpdir(), "ralph-bin-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const piRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
	mkdirSync(join(piRoot, "dist", "bundle"), { recursive: true });
	writeFileSync(join(piRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
	const cli = join(piRoot, "dist", "bundle", "cli.js");
	writeFileSync(cli, "#!/usr/bin/env node\n", { mode: 0o755 });
	// Mirror a hoisted pi installation, using real installed loaders and UI code.
	if (omit !== "jiti") symlinkSync(join(require.resolve("jiti/package.json"), ".."), join(root, "node_modules", "jiti"), "dir");
	const tuiRoot = fileURLToPath(new URL("../node_modules/@earendil-works/pi-tui", import.meta.url));
	if (omit !== "pi-tui") symlinkSync(tuiRoot, join(root, "node_modules", "@earendil-works", "pi-tui"), "dir");
	mkdirSync(join(root, "bin"));
	symlinkSync(cli, join(root, "bin", "pi"));
	return join(root, "bin");
}

test("ralph prints usage through a pi installation for no args and help", (t) => {
	const path = fakePi(t);
	for (const args of [[], ["-h"], ["--help"]]) {
		const result = spawnSync(process.execPath, [bin, ...args], {
			env: { ...process.env, PATH: path }, encoding: "utf-8", timeout: 10_000,
		});
		assert.equal(result.error, undefined);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Usage: ralph/);
		assert.equal(result.stderr, "");
	}
});

test("ralph fails clearly when pi is not on PATH", (t) => {
	const path = mkdtempSync(join(tmpdir(), "ralph-empty-path-"));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	const result = spawnSync(process.execPath, [bin], {
		env: { ...process.env, PATH: path }, encoding: "utf-8", timeout: 10_000,
	});
	assert.equal(result.error, undefined);
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /cannot find pi installation \(tried: PATH lookup for pi\)/);
	assert.match(result.stderr, /pi executable not found on PATH/);
});

test("ralph rejects unknown commands, a missing root and extra help arguments", (t) => {
	const path = fakePi(t);
	for (const args of [["frobnicate", "."], ["watch"], ["--help", "extra"]]) {
		const result = spawnSync(process.execPath, [bin, ...args], {
			env: { ...process.env, PATH: path }, encoding: "utf-8", timeout: 10_000,
		});
		assert.equal(result.error, undefined);
		assert.equal(result.status, 2);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /Usage: ralph/);
	}
});

test("ralph names the pi path when the executable is not in a pi package", (t) => {
	const path = mkdtempSync(join(tmpdir(), "ralph-invalid-pi-"));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	const pi = join(path, "pi");
	writeFileSync(pi, "#!/usr/bin/env node\n", { mode: 0o755 });
	const result = spawnSync(process.execPath, [bin], {
		env: { ...process.env, PATH: path }, encoding: "utf-8", timeout: 10_000,
	});
	assert.equal(result.error, undefined);
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.ok(result.stderr.includes(`cannot find pi installation (tried: ${pi})`));
	assert.match(result.stderr, /pi package root not found/);
});

test("bin awaits async command and reports mission error not installation failure", (t) => {
	const path = fakePi(t);
	const root = mkdtempSync(join(tmpdir(), "ralph-bin-root-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const result = spawnSync(process.execPath, [bin, "launch", root], {
		env: { ...process.env, PATH: path }, encoding: "utf-8", timeout: 20_000,
	});
	assert.equal(result.error, undefined);
	assert.equal(result.status, 1, result.stderr);
	assert.equal(result.stdout, "");
	assert.doesNotMatch(result.stderr, /cannot find pi installation/);
	assert.match(result.stderr, /^ralph: .*mission\.json/m);
});


for (const install of ["plain", "node_modules"] as const) test(`packaged status runs under ${install} on native Node without pi, jiti or pi-tui`, (t) => {
	const f = new Fixture([{ id: "A", passes: false }]);
	t.after(() => f.close());
	f.state(true, T("10:00"), "run-a", { owner_heartbeat_at: new Date().toISOString() });
	const root = mkdtempSync(join(tmpdir(), "ralph-native-status-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const packageRoot = install === "node_modules" ? join(root, "node_modules/pi-ralph-loop") : root;
	cpSync(fileURLToPath(new URL("../src", import.meta.url)), join(packageRoot, "src"), { recursive: true });
	writeFileSync(join(packageRoot, "package.json"), '{"type":"module"}');
	mkdirSync(join(root, "bin"));
	const git = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
	symlinkSync(git, join(root, "bin", "git"));
	const packagedBin = join(packageRoot, "src/watch/ralph.mjs");
	const run = (...args: string[]) => spawnSync(process.execPath, [packagedBin, "status", ...args], {
		cwd: tmpdir(), env: { ...process.env, PATH: join(root, "bin"), NODE_OPTIONS: "" }, encoding: "utf8", timeout: 10_000,
	});
	const partial = run(f.root);
	assert.equal(partial.error, undefined);
	assert.equal(partial.status, 3, partial.stderr);
	assert.equal(partial.stderr, "");
	assert.match(partial.stdout, /^items: 0\/1 passed$/m);
	assert.match(partial.stdout, /^health: RUNNING$/m);
	assert.match(partial.stdout, /^coverage: partial$/m);
	assert.doesNotMatch(partial.stdout, /\x1b/);
	const usage = run(f.root, "extra");
	assert.equal(usage.status, 2, usage.stderr);
	assert.equal(usage.stdout, "");
	assert.match(usage.stderr, /Usage: ralph/);
	const failure = run(join(root, "missing"));
	assert.equal(failure.status, 1, failure.stderr);
	assert.equal(failure.stdout, "");
	assert.doesNotMatch(failure.stderr, /cannot find pi installation/);
	// Inject warnings at the platform boundary, keeping real type stripping.
	// An identical warning outside package stripping must also stay visible.
	const preload = join(root, "warnings.mjs");
	writeFileSync(preload, `
import module, { syncBuiltinESMExports } from "node:module";
const exact = "stripTypeScriptTypes is an experimental feature and might change at any time";
process.emitWarning(exact, "ExperimentalWarning");
const strip = module.stripTypeScriptTypes;
let first = true;
module.stripTypeScriptTypes = (...args) => {
	if (first) {
		first = false;
		process.emitWarning("unrelated experimental warning", "ExperimentalWarning");
		process.emitWarning(exact, "DeprecationWarning");
	}
	return strip(...args);
};
syncBuiltinESMExports();
`);
	const warned = spawnSync(process.execPath, ["--import", preload, packagedBin, "status", f.root], {
		cwd: tmpdir(), env: { ...process.env, PATH: join(root, "bin"), NODE_OPTIONS: "" }, encoding: "utf8", timeout: 10_000,
	});
	assert.equal(warned.error, undefined);
	assert.equal(warned.status, 3, warned.stderr);
	assert.match(warned.stdout, /^coverage: partial$/m);
	assert.match(warned.stderr, /ExperimentalWarning: unrelated experimental warning/);
	assert.match(warned.stderr, /DeprecationWarning: stripTypeScriptTypes is an experimental feature/);
	assert.equal(warned.stderr.match(/ExperimentalWarning: stripTypeScriptTypes is an experimental feature/g)?.length, 1);
});

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventServer, writeMetadata } from "../src/watch/transport.ts";

// Use async subprocess I/O so the real event socket can answer the native bin.
test("native status prints complete evidence on stdout and exits 0 without pi", async (t) => {
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: false }]);
	t.after(() => f.close());
	f.state(true, T("10:00"), "run-a", { owner_heartbeat_at: new Date().toISOString() });
	f.journal([
		{ v: 1, k: "run", r: "L1", t: T("10:00"), m: "m", th: "off", mx: 9, tk: "b" },
		{ v: 1, k: "loop", r: "L1", t: T("10:00"), tok: "run-a", sa: T("10:00"), i: 1, ph: "initialized" },
	]);
	f.pass("A", T("10:30"));
	const directory = mkdtempSync(join(tmpdir(), "rs-bin-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const socket = join(directory, "events.sock");
	const server = new EventServer(socket, () => ({
		v: 1, type: "hello", launchId: "L1", pid: process.pid, nextSeq: 1, lastPiAt: new Date().toISOString(),
		loop: { token: "run-a", startedAt: T("10:00"), iteration: 1 }, tools: [], state: "launched",
		totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, messages: 0, dialogsCancelled: 0, refusals: 0 },
		counters: { dialogsCancelled: 0, refusals: 0, badRecords: 0, badFacts: 0, subscriberDrops: 0 },
	}), () => {});
	await server.listen();
	t.after(() => server.close());
	writeMetadata(f.root, { v: 1, pid: process.pid, launchId: "L1", eventSocket: socket, factSocket: socket, fifo: join(directory, "fifo"), startedAt: T("10:00") });
	const git = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
	mkdirSync(join(directory, "bin"));
	symlinkSync(git, join(directory, "bin/git"));
	const { stdout, stderr } = await promisify(execFile)(process.execPath, [bin, "status", f.root], {
		env: { ...process.env, PATH: join(directory, "bin"), NODE_OPTIONS: "" }, cwd: tmpdir(), timeout: 10_000,
	});
	assert.equal(stderr, "");
	assert.match(stdout, /^items: 1\/2 passed$/m);
	assert.match(stdout, /^current item: B .*$/m);
	assert.match(stdout, /^health: RUNNING$/m);
	assert.match(stdout, /^ETA: estimate 1800000 ms; n=1$/m);
	assert.match(stdout, /^coverage: complete$/m);
	assert.doesNotMatch(stdout, /^warning:/m);
});

for (const module of ["jiti", "pi-tui"] as const) {
	test(`ralph names ${module} and the pi package root it tried when ${module} is missing`, (t) => {
		const path = fakePi(t, module);
		// The bin follows the real path of pi, so the tried root is the real package directory.
		const piRoot = realpathSync(join(path, "..", "node_modules", "@earendil-works", "pi-coding-agent"));
		const result = spawnSync(process.execPath, [bin, "--help"], {
			env: { ...process.env, PATH: path }, encoding: "utf-8", timeout: 10_000,
		});
		assert.equal(result.error, undefined);
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		const name = module === "jiti" ? "jiti" : "@earendil-works/pi-tui";
		assert.ok(result.stderr.includes(`ralph: cannot find ${name} (tried: ${piRoot} (resolving from the pi package root))`), result.stderr);
		assert.doesNotMatch(result.stderr, /cannot find pi installation/);
	});
}

test("ralph watch loads the viewer through pi and reports a bad root as a command error", (t) => {
	const path = fakePi(t);
	const result = spawnSync(process.execPath, [bin, "watch", "/nonexistent/ralph-watch-root"], {
		env: { ...process.env, PATH: path }, encoding: "utf-8", timeout: 20_000,
	});
	assert.equal(result.error, undefined);
	assert.equal(result.status, 1, result.stderr);
	assert.equal(result.stdout, "");
	assert.doesNotMatch(result.stderr, /cannot find/);
	assert.match(result.stderr, /^ralph: ENOENT: .*'\/nonexistent'/m);
});
