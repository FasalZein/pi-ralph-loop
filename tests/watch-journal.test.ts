import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { JournalWriter, JOURNAL_CAP_BYTES, parseJournal, readJournal } from "../src/watch/journal.ts";
import type { JournalRecord } from "../src/watch/types.ts";

const header: Extract<JournalRecord, { k: "run" }> = { v: 1, t: "2026-09-30T00:00:00.000Z", r: "launch", k: "run", m: "model", th: "high", mx: 10, tk: "p" };
function root(t: test.TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "rw-journal-"));
	mkdirSync(join(dir, ".ralph"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("journal: records stay compact and exclude unknown classes", () => {
	const line = JSON.stringify(header);
	assert.ok(Buffer.byteLength(line) < 160);
	const parsed = parseJournal(`${line}\n{\"v\":1,\"k\":\"raw\"}\nbad\npartial`);
	assert.deepEqual(parsed.records, [header]);
	assert.equal(parsed.badLines, 2);
	assert.equal(parsed.partialTail, "partial");
});

test("journal: rotates at 1 MB, re-emits run header and keeps one rotated file", (t) => {
	const dir = root(t);
	const writer = new JournalWriter(dir, header);
	const intervention: JournalRecord = { ...header, k: "x", op: "steer", id: "control", ok: 1, txt: "a".repeat(120_000) };
	for (let i = 0; i < 20; i++) writer.append(intervention);
	const path = join(dir, ".ralph/journal.jsonl");
	const previous = join(dir, ".ralph/journal.1.jsonl");
	assert.ok(statSync(path).size <= JOURNAL_CAP_BYTES);
	assert.ok(statSync(previous).size <= JOURNAL_CAP_BYTES);
	assert.deepEqual(readdirSync(join(dir, ".ralph")).sort(), ["journal.1.jsonl", "journal.jsonl"]);
	assert.deepEqual(parseJournal(readFileSync(path, "utf8")).records[0], header);
	assert.deepEqual(parseJournal(readFileSync(previous, "utf8")).records[0], header);
	assert.equal(writer.errors, 0);
});

test("journal: repairs a torn trailing line on open", (t) => {
	const dir = root(t);
	writeFileSync(join(dir, ".ralph/journal.jsonl"), "{torn");
	new JournalWriter(dir, header);
	const parsed = parseJournal(readFileSync(join(dir, ".ralph/journal.jsonl"), "utf8"));
	assert.equal(parsed.badLines, 1);
	assert.deepEqual(parsed.records, [header]);
	assert.equal(parsed.partialTail, "");
});

test("readJournal: reads rotated file then current and counts partial tails", (t) => {
	const dir = root(t);
	writeFileSync(join(dir, ".ralph/journal.1.jsonl"), `${JSON.stringify({ ...header, r: "older" })}\n`);
	writeFileSync(join(dir, ".ralph/journal.jsonl"), `${JSON.stringify(header)}\ntorn`);
	const read = readJournal(dir);
	assert.deepEqual(read.records.map((r) => r.r), ["older", "launch"]);
	assert.equal(read.badLines, 1);
	assert.equal(read.rotated, true);
});

test("journal: retains full steer text including text larger than one file", (t) => {
	const dir = root(t);
	const writer = new JournalWriter(dir, header);
	const text = "z".repeat(1_100_000);
	writer.append({ ...header, k: "x", op: "steer", id: "long", ok: 1, txt: text });
	const parts = readJournal(dir).records.filter((r) => r.k === "x");
	assert.equal(parts.map((r) => r.k === "x" ? r.txt : "").join(""), text);
	assert.ok(statSync(join(dir, ".ralph/journal.jsonl")).size <= JOURNAL_CAP_BYTES);
	assert.ok(statSync(join(dir, ".ralph/journal.1.jsonl")).size <= JOURNAL_CAP_BYTES);
});

test("journal: I/O errors are reported without throwing", (t) => {
	const dir = root(t);
	const messages: string[] = [];
	rmSync(join(dir, ".ralph"), { recursive: true });
	const writer = new JournalWriter(dir, header, (line) => messages.push(line));
	writer.append({ ...header, k: "d", e: "start" });
	assert.equal(writer.errors, 2);
	assert.equal(messages.length, 2);
});
