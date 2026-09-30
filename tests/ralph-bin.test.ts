import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const bin = fileURLToPath(new URL("../src/watch/ralph.mjs", import.meta.url));
const require = createRequire(import.meta.url);

function fakePi(t: test.TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "ralph-bin-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const piRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
	mkdirSync(join(piRoot, "dist", "bundle"), { recursive: true });
	writeFileSync(join(piRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
	const cli = join(piRoot, "dist", "bundle", "cli.js");
	writeFileSync(cli, "#!/usr/bin/env node\n", { mode: 0o755 });
	// Mirror a hoisted pi installation, using real installed loaders and UI code.
	symlinkSync(join(require.resolve("jiti/package.json"), ".."), join(root, "node_modules", "jiti"), "dir");
	const tuiRoot = fileURLToPath(new URL("../node_modules/@earendil-works/pi-tui", import.meta.url));
	symlinkSync(tuiRoot, join(root, "node_modules", "@earendil-works", "pi-tui"), "dir");
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

test("ralph rejects unimplemented commands and extra help arguments", (t) => {
	const path = fakePi(t);
	for (const args of [["status", "."], ["--help", "extra"]]) {
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
