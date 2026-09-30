import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type { JournalRecord } from "./types.js";

export const JOURNAL_CAP_BYTES = 1_048_576;

export function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validRecord(value: unknown): value is JournalRecord {
	if (!object(value) || value.v !== 1 || typeof value.t !== "string" || typeof value.r !== "string") return false;
	const strings = (...keys: string[]) => keys.every((key) => typeof value[key] === "string");
	const numbers = (...keys: string[]) => keys.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]));
	if (value.why !== undefined && typeof value.why !== "string") return false;
	switch (value.k) {
		case "run": return strings("m", "th") && numbers("mx") && (value.tk === "b" || value.tk === "p");
		case "loop": return strings("tok", "sa") && numbers("i") && (value.ph === "initialized" || value.ph === "resumed");
		case "g": return strings("tok") && numbers("i") && ["NEXT", "STOP", "COMPLETE", "WAIT"].includes(String(value.p)) && (value.ok === 0 || value.ok === 1);
		case "u": return (value.tok === null || strings("tok")) && numbers("i", "in", "out", "cr", "cw", "c", "n", "dc", "pr");
		case "x": return (value.op === "stop" || value.op === "steer") && (value.id === null || strings("id")) && (value.ok === 0 || value.ok === 1) && (value.txt === undefined || strings("txt")) && (value.part === undefined || numbers("part"));
		case "d": return ["start", "ready", "launched", "gate-wait", "pi-not-ready", "pi-exit", "gap", "exit"].includes(String(value.e)) && (value.c === undefined || value.c === null || numbers("c"));
		default: return false;
	}
}
export function parseJournal(text: string): { records: JournalRecord[]; partialTail: string; badLines: number } {
	const lines = text.split("\n");
	const partialTail = lines.pop() ?? "";
	const records: JournalRecord[] = [];
	let badLines = 0;
	for (const line of lines) {
		if (!line) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (validRecord(value)) records.push(value);
			else badLines++;
		} catch { badLines++; }
	}
	return { records, partialTail, badLines };
}
export function readJournal(root: string): { records: JournalRecord[]; badLines: number; rotated: boolean } {
	const records: JournalRecord[] = [];
	let badLines = 0;
	const rotated = existsSync(join(root, ".ralph/journal.1.jsonl"));
	for (const name of ["journal.1.jsonl", "journal.jsonl"]) {
		const path = join(root, ".ralph", name);
		if (!existsSync(path)) continue;
		const parsed = parseJournal(readFileSync(path, "utf8"));
		records.push(...parsed.records);
		badLines += parsed.badLines + (parsed.partialTail ? 1 : 0);
	}
	return { records, badLines, rotated };
}

export class JournalWriter {
	private readonly path: string;
	private readonly rotated: string;
	private size = 0;
	public errors = 0;
	constructor(root: string, private readonly header: Extract<JournalRecord, { k: "run" }>, private readonly log: (line: string) => void = console.error) {
		this.path = join(root, ".ralph/journal.jsonl");
		this.rotated = join(root, ".ralph/journal.1.jsonl");
		this.safe(() => {
			if (existsSync(this.path)) {
				const contents = readFileSync(this.path);
				this.size = contents.length;
				if (contents.length && contents.at(-1) !== 10) {
					appendFileSync(this.path, "\n");
					this.size++;
				}
			}
		});
		this.append(header);
	}
	private safe(action: () => void): void {
		try { action(); } catch (error) { this.errors++; this.log(`journal: ${String(error)}`); }
	}
	append(record: JournalRecord): void {
		// Full operator text is retained, not truncated. Exceptionally large
		// interventions use numbered fragments; normal retention still applies.
		const line = `${JSON.stringify(record)}\n`;
		const header = `${JSON.stringify(this.header)}\n`;
		if (Buffer.byteLength(line) + Buffer.byteLength(header) > JOURNAL_CAP_BYTES) {
			if (record.k !== "x" || !record.txt) {
				this.safe(() => { throw new Error("record exceeds journal capacity"); });
				return;
			}
			let part = 0;
			// Bound JSON escaping as well as UTF-8 bytes (6 bytes per code unit).
			for (let offset = 0; offset < record.txt.length; offset += 80_000) {
				this.append({ ...record, txt: record.txt.slice(offset, offset + 80_000), part: part++ });
			}
			return;
		}
		this.safe(() => {
			// Re-read after an I/O failure instead of trusting a derived counter.
			this.size = existsSync(this.path) ? statSync(this.path).size : 0;
			if (this.size + Buffer.byteLength(line) > JOURNAL_CAP_BYTES) {
				renameSync(this.path, this.rotated);
				appendFileSync(this.path, header);
				this.size = Buffer.byteLength(header);
			}
			appendFileSync(this.path, line);
			this.size += Buffer.byteLength(line);
		});
	}
}
