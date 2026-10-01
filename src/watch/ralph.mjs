#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Status contract: Node >=22.18 with native TypeScript stripping and module
// hooks. It does not resolve pi, jiti or pi-tui. Other commands keep pi's loader.
async function runNativeStatus() {
	try {
		const [major, minor] = process.versions.node.split(".").map(Number);
		const { registerHooks, stripTypeScriptTypes } = await import("node:module");
		if (major < 22 || (major === 22 && minor < 18) || !process.features.typescript || typeof registerHooks !== "function" || typeof stripTypeScriptTypes !== "function") {
			throw new Error("status requires Node 22.18 or later with native TypeScript support");
		}
		const sourceRoot = new URL("../", import.meta.url).href;
		// Authority: parent decision for #7 fix round 1. Suppress only Node's
		// exact stripTypeScriptTypes warning during our own synchronous call.
		// Restoring emitWarning in finally preserves all other warning behavior.
		const stripPackageTypes = (source, url) => {
			const emitWarning = process.emitWarning;
			process.emitWarning = (warning, ...args) => {
				if (warning === "stripTypeScriptTypes is an experimental feature and might change at any time" && args[0] === "ExperimentalWarning") return;
				return emitWarning.call(process, warning, ...args);
			};
			try { return stripTypeScriptTypes(source, { mode: "strip", sourceUrl: url }); }
			finally { process.emitWarning = emitWarning; }
		};
		const hooks = registerHooks({
			load(url, context, nextLoad) {
				// Node's default loader rejects .ts under node_modules. Strip only
				// this package's source, regardless of its installation directory.
				if (url.startsWith(sourceRoot) && url.endsWith(".ts")) {
					return { format: "module", source: stripPackageTypes(readFileSync(new URL(url), "utf8"), url), shortCircuit: true };
				}
				return nextLoad(url, context);
			},
			// Existing source uses .js specifiers for TypeScript. Map only relative
			// imports inside this package's source, never external package imports.
			resolve(specifier, context, nextResolve) {
				if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith(".") && specifier.endsWith(".js")) {
					const candidate = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
					if (candidate.href.startsWith(sourceRoot) && existsSync(candidate)) return nextResolve(candidate.href, context);
				}
				return nextResolve(specifier, context);
			},
		});
		try {
			const { main } = await import("./cli.ts");
			process.exitCode = await main(process.argv.slice(2));
		} finally { hooks.deregister(); }
	} catch (error) {
		console.error(`ralph: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}

async function runWithPiLoader() {
	let tried = "PATH lookup for pi";
	let jiti;
	try {
		const pi = (process.env.PATH ?? "").split(delimiter)
			.map((entry) => join(entry, "pi"))
			.find((path) => existsSync(path) && statSync(path).isFile());
		if (!pi) throw new Error("pi executable not found on PATH");
		tried = pi;
		let root = dirname(realpathSync(pi));
		while (true) {
			const manifest = join(root, "package.json");
			if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf-8")).name === "@earendil-works/pi-coding-agent") break;
			const parent = dirname(root);
			if (parent === root) throw new Error("pi package root not found");
			root = parent;
		}
		const require = createRequire(join(root, "package.json"));
		const { createJiti } = require("jiti");
		jiti = createJiti(import.meta.url, {
			alias: { "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui") },
		});
	} catch (error) {
		console.error(`ralph: cannot find pi installation (tried: ${tried}): ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
	// Command errors are reported as such, never as a missing pi installation.
	if (jiti) {
		try {
			const { main } = await jiti.import(fileURLToPath(new URL("./cli.ts", import.meta.url)));
			process.exitCode = await main(process.argv.slice(2));
		} catch (error) {
			console.error(`ralph: ${error instanceof Error ? error.message : String(error)}`);
			process.exitCode = 1;
		}
	}
}

if (process.argv[2] === "status") await runNativeStatus();
else await runWithPiLoader();
