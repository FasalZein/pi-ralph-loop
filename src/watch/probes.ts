import path from "node:path";
import { isRecord } from "../bundle/schema.js";

/** T12 runs commands; pure evaluation consumes results. Readers never run author code. */
export type ProbeResult<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "unavailable"; readonly reason: string };
export type EnforcementProbes = {
	readonly measure?: ProbeResult<Readonly<Record<string, number>>>;
	/** One command result per item, resolved with that item's target paths as extra argv. */
	readonly importers?: Readonly<Record<string, ProbeResult<readonly string[]>>>;
};
function parse<T>(stdout: string, validate: (value: unknown) => T): ProbeResult<T> {
	try { return { kind: "ok", value: validate(JSON.parse(stdout)) }; }
	catch (error) { return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) }; }
}
export function parseMeasureOutput(stdout: string): ProbeResult<Readonly<Record<string, number>>> {
	return parse(stdout, value => {
		if (!isRecord(value)) throw new Error("measure stdout must be a JSON counter map");
		const counts: Record<string, number> = {};
		for (const [key, count] of Object.entries(value)) {
			if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error(`invalid measure count ${JSON.stringify(key)}`);
			Object.defineProperty(counts, key, { value: count, enumerable: true });
		}
		return Object.freeze(counts);
	});
}
export function parseImporterOutput(stdout: string): ProbeResult<readonly string[]> {
	return parse(stdout, value => {
		if (!Array.isArray(value)) throw new Error("importer stdout must be a JSON path array");
		const paths: string[] = [];
		for (const file of value) {
			if (typeof file !== "string" || !file.trim() || file.includes("\0") || file.includes("\\") || path.posix.isAbsolute(file) || /^[a-z]:/i.test(file) || file.split("/").includes("..")) throw new Error("importer paths must be root-relative POSIX paths without traversal");
			paths.push(path.posix.normalize(file));
		}
		return Object.freeze([...new Set(paths)]);
	});
}
