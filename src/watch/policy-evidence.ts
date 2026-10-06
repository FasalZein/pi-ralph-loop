import { isRecord, parseBundleItemsJson } from "../bundle/schema.js";
import { keyItems } from "./loop-state.js";
import type { DebtSide, ItemsDiff, MissionBaseline } from "./types.js";

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
