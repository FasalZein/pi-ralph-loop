import { isRecord, parseBundleItemsJson } from "../bundle/schema.js";
import type { BundleItem } from "../bundle/types.js";
import { isTestPath } from "./content.js";
import type { DebtSide, FileChange, ItemsDiff, Mission, MissionBaseline, SeamPolicyEvidence } from "./types.js";

/** Parse the configured JSON Pointer and flat debt schema, without treating invalid data as zero. */
export function debtSide(text: string | null, baseline: MissionBaseline): DebtSide {
	if (text === null) return { kind: "absent" };
	try {
		let value: unknown = JSON.parse(text);
		for (const part of baseline.schema.pointer === "" ? [] : baseline.schema.pointer.slice(1).split("/")) {
			const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
			if (Array.isArray(value) && /^(0|[1-9][0-9]*)$/.test(key) && Object.hasOwn(value, key)) value = value[Number(key)];
			else if (isRecord(value) && Object.hasOwn(value, key)) value = value[key];
			else throw new Error("pointer does not locate baseline data");
		}
		if (baseline.schema.kind === "entry-array") {
			if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string" && !!entry.trim()) || new Set(value).size !== value.length) throw new Error("invalid entry array");
			return { kind: "ok", value };
		}
		if (!isRecord(value)) throw new Error("invalid counter map");
		const counts: Record<string, number> = Object.create(null);
		for (const [key, count] of Object.entries(value)) {
			if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error(`invalid count ${key}`);
			counts[key] = count;
		}
		return { kind: "ok", value: counts };
	} catch (error) { return { kind: "invalid", reason: error instanceof Error ? error.message : String(error) }; }
}
// Object key order is not a field mutation. Array order is meaningful.
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isRecord(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
	return JSON.stringify(value);
}
export function itemsDiff(before: string | null, after: string | null): ItemsDiff | { unavailable: string } {
	try {
		const parse = (text: string | null) => {
			if (text === null) return { rows: [], document: {} };
			const document = parseBundleItemsJson(text);
			const rows = keyItems(document.items);
			if (typeof rows === "string") throw new Error(rows);
			return { rows, document: Object.fromEntries(Object.entries(document).filter(([key]) => key !== "items")) };
		};
		const old = parse(before), now = parse(after);
		const a = new Map(old.rows.map(row => [row.key, row.item]));
		const b = new Map(now.rows.map(row => [row.key, row.item]));
		return {
			inserted: [...b.keys()].filter(key => !a.has(key)), removed: [...a.keys()].filter(key => !b.has(key)),
			unpassed: [...b].filter(([key, item]) => a.get(key)?.passes === true && !item.passes).map(([key]) => key),
			passed: [...b].filter(([key, item]) => a.get(key)?.passes === false && item.passes).map(([key]) => key),
			edited: [...b].flatMap(([key, item]) => {
				const previous = a.get(key); if (!previous) return [];
				const fields = [...new Set([...Object.keys(previous), ...Object.keys(item)])].filter(field => field !== "passes" && canonical(previous[field]) !== canonical(item[field]));
				if (old.rows.findIndex(row => row.key === key) !== now.rows.findIndex(row => row.key === key)) fields.push("order");
				return fields.length ? [{ key, fields }] : [];
			}),
			beforePending: old.rows.filter(row => !row.item.passes).map(row => row.key),
			documentEdited: canonical(old.document) !== canonical(now.document),
		};
	} catch (error) { return { unavailable: error instanceof Error ? error.message : String(error) }; }
}

export type KeyedItem = { readonly key: string; readonly index: number; readonly item: BundleItem };
const nonBlank = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
/**
 * Item key: explicit nonblank id, else `index:N`. Descriptions are never keys.
 * A present id or title that is not a nonblank string is invalid, not absent.
 */
export function keyItems(items: readonly BundleItem[]): KeyedItem[] | string {
	const keyed: KeyedItem[] = [];
	for (const [index, item] of items.entries()) {
		if (item.id !== undefined && !nonBlank(item.id)) return `items[${index}].id must be a nonblank string`;
		if (item.title !== undefined && !nonBlank(item.title)) return `items[${index}].title must be a nonblank string`;
		keyed.push({ key: (item.id as string | undefined) ?? `index:${index}`, index, item });
	}
	if (new Set(keyed.map((k) => k.key)).size !== keyed.length) return "duplicate bundle item key";
	return keyed;
}

/** Only the observation reader supplies I/O, inside its consistent git window. */
export type PolicyEvidenceRuntime = {
	numstat(): Promise<string>;
	content(change: FileChange): Promise<FileChange["content"]>;
};
export async function collectPolicyEvidence(
	changes: readonly FileChange[], mission: Mission | null, worktree: boolean,
	runtime: PolicyEvidenceRuntime, signal: AbortSignal,
): Promise<SeamPolicyEvidence> {
	const numstat: { path: string; added: number | null; removed: number | null }[] = [];
	// No line-count policy exists without thresholds.
	const stats = mission?.thresholds ? await runtime.numstat() : "";
	for (const row of stats.split("\0").filter(Boolean)) {
		const first = row.indexOf("\t"), second = row.indexOf("\t", first + 1);
		if (first < 0 || second < 0) throw new Error("invalid numstat row");
		const count = (text: string) => {
			if (text === "-") return null;
			if (!/^\d+$/.test(text)) throw new Error("invalid numstat count");
			return Number(text);
		};
		numstat.push({ path: row.slice(second + 1), added: count(row.slice(0, first)), removed: count(row.slice(first + 1, second)) });
	}
	const debt: Record<string, { before: DebtSide; after: DebtSide }> = Object.create(null);
	const oldLines: Record<string, readonly string[]> = Object.create(null);
	let items: SeamPolicyEvidence["items"] = null;
	for (const change of changes) {
		const rel = change.path;
		const baselines = mission?.baselines.filter(b => b.file === rel) ?? [];
		const itemFile = mission?.task.kind === "bundle" && rel === ".ralph/items.json";
		const test = isTestPath(mission, rel);
		const untracked = worktree && change.status === "A";
		if (!baselines.length && !itemFile && !test && !(untracked && mission?.thresholds?.largeDiffLines !== undefined)) {
			if (untracked && mission?.thresholds) numstat.push({ path: rel, added: null, removed: 0 });
			continue;
		}
		let before: string | null = null, after: string | null = null, failure: string | null = null;
		let content: FileChange["content"] = change.content;
		try {
			if (change.status === "U" || change.status === "T") throw new Error("unmerged or non-regular file");
			// Generic evidence already holds both sides. Fetch only unscanned policy files.
			if (content.kind === "skipped") content = await runtime.content(change);
			if (content.kind !== "lines") throw new Error(content.kind === "unavailable" ? content.reason : "content not collected");
			before = change.status === "A" ? null : content.oldLines.join("\n");
			after = change.status === "D" ? null : content.lines.join("\n");
			if (test) oldLines[rel] = content.oldLines;
		} catch (error) {
			if (signal.aborted) throw error;
			failure = error instanceof Error ? error.message : String(error);
		}
		if (untracked && mission?.thresholds) numstat.push({ path: rel, added: failure || content.kind !== "lines" ? null : content.lines.length, removed: 0 });
		if (itemFile) items = failure ? { unavailable: failure } : itemsDiff(before, after);
		for (const baseline of baselines) debt[baseline.name] = failure
			? { before: { kind: "invalid", reason: failure }, after: { kind: "invalid", reason: failure } }
			: { before: debtSide(before, baseline), after: debtSide(after, baseline) };
	}
	return { numstat, items, debt, oldLines };
}
