import assert from "node:assert/strict";
import test from "node:test";
import { applyFrame, disconnect, emptyFeed, feedRows, visibleEntries } from "../src/watch/viewer/live.ts";
import { emptyTotals } from "../src/watch/rpc.ts";
import type { EventFrame, ToolEntry } from "../src/watch/types.ts";

const at = "2026-10-06T10:00:00.000Z";
const tool = (id: string, name = "read"): ToolEntry => ({ id, name, label: "file.ts", startedAt: at, endedAt: null });
const hello = (tools: readonly ToolEntry[] = [], nextSeq = 1): Extract<EventFrame, { type: "hello" }> => ({ v: 1, type: "hello", launchId: "launch", pid: 1, nextSeq, lastPiAt: at, loop: { token: "token", startedAt: at, iteration: 1 }, tools, totals: emptyTotals(), counters: { dialogsCancelled: 0, refusals: 0, badRecords: 0, badFacts: 0, subscriberDrops: 0 }, state: "launched" });
const event = (seq: number, e: Extract<EventFrame, { type: "event" }>["event"]): Extract<EventFrame, { type: "event" }> => ({ v: 1, type: "event", seq, at, event: e });

test("live feed replays tools, merges ends and keeps a 200-entry ring", () => {
	let feed = applyFrame(emptyFeed(), hello([tool("replayed")]));
	assert.match(feedRows(feed, "all")[0], /Read file.ts/);
	feed = applyFrame(feed, event(1, { kind: "tool-end", tool: { ...tool("replayed"), endedAt: at, ms: 10, error: false } }));
	assert.equal(feed.entries.length, 1);
	assert.match(feedRows(feed, "all")[0], /10ms/);
	for (let i = 2; i <= 205; i++) feed = applyFrame(feed, event(i, { kind: "tool-start", tool: tool(String(i)) }));
	assert.equal(feed.entries.length, 200);
	assert.equal(visibleEntries(feed, "tools")[0].kind, "tool");
	assert.ok(!JSON.stringify(feed.entries).includes("replayed"));
});

test("filters and safe verbs preserve messages and failures without terminal controls", () => {
	let feed = applyFrame(emptyFeed(), hello());
	for (const [i, name] of ["read", "grep", "find", "ls", "edit", "write", "bash", "custom"].entries()) feed = applyFrame(feed, event(i + 1, { kind: "tool-start", tool: tool(name, name) }));
	feed = applyFrame(feed, event(9, { kind: "message", text: "hello\x1b[2J\x1b]0;bad\x07\r\u009b" }));
	feed = applyFrame(feed, event(10, { kind: "refusal", tool: "bash", text: "no" }));
	assert.equal(visibleEntries(feed, "tools").length, 8);
	assert.equal(visibleEntries(feed, "messages").length, 1);
	assert.equal(visibleEntries(feed, "errors").length, 1);
	assert.match(feedRows(feed, "tools").join("\n"), /Read.*\nSearch.*\nSearch.*\nSearch.*\nEdit.*\nEdit.*\nExecute.*\ncustom/);
	assert.doesNotMatch(feedRows(feed, "messages").join(""), /[\x00-\x1f\x7f-\x9f]/);
});

test("disconnects and sequence loss show gaps; facts never refresh pi activity", () => {
	let feed = applyFrame(emptyFeed(), hello());
	feed = applyFrame(feed, event(1, { kind: "activity" }));
	feed = disconnect(feed, "socket lost");
	assert.equal(feed.connected, false);
	assert.match(feedRows(feed, "all").join("\n"), /activity unavailable/);
	feed = applyFrame(feed, hello([tool("buffered")], 5));
	assert.match(feedRows(feed, "all").join("\n"), /gap/);
	assert.match(feedRows(feed, "all").join("\n"), /Read file.ts/);
	feed = applyFrame(feed, { v: 1, type: "gap", seq: 5, at, source: "facts", from: 1, to: 3 });
	feed = applyFrame(feed, { ...event(6, { kind: "fact", fact: { kind: "iteration-start", phase: "entered", iteration: 2, at, run: { launchId: "launch", loopToken: "token", startedAt: at } } }), at: "2026-10-06T11:00:00.000Z" });
	assert.equal(feed.lastPiAt, at);
	assert.match(feedRows(feed, "all").join("\n"), /iteration 2/);
	// A different driver/run clears rows and sequence evidence from the old run.
	feed = applyFrame(feed, { ...hello(), launchId: "new" });
	assert.equal(feed.entries.length, 0);
});

test("tool IDs reused after an iteration boundary do not overwrite earlier activity", () => {
	let feed = applyFrame(emptyFeed(), hello([tool("reused")]));
	feed = applyFrame(feed, event(1, { kind: "fact", fact: { kind: "iteration-start", phase: "entered", iteration: 2, at, run: { launchId: "launch", loopToken: "token", startedAt: at } } }));
	feed = applyFrame(feed, event(2, { kind: "tool-start", tool: { ...tool("reused", "edit"), label: "new.ts" } }));
	assert.deepEqual(feedRows(feed, "tools"), ["Read file.ts", "Edit new.ts"]);
	feed = applyFrame(feed, event(3, { kind: "assistant-end", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, stopReason: "error", model: null }));
	assert.deepEqual(feedRows(feed, "errors"), ["⚠ agent error"]);
});
