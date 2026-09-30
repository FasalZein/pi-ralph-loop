#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let tried = "PATH lookup for pi";
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
	const jiti = createJiti(import.meta.url, {
		alias: { "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui") },
	});
	const { main } = await jiti.import(fileURLToPath(new URL("./cli.ts", import.meta.url)));
	process.exitCode = main(process.argv.slice(2));
} catch (error) {
	console.error(`ralph: cannot find pi installation (tried: ${tried}): ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
