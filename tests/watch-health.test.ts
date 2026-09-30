import assert from "node:assert/strict";
import { unlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { deriveLiveness, STALLED_AFTER_MS } from "../src/watch/health.ts";
import { openLoop } from "../src/watch/loop-state.ts";
import { Fixture, T, clock, readOnce } from "./fixtures/loop-state.ts";

for (const [seconds, stale] of [[45, false], [60, false], [61, true]] as const) test(`heartbeat age ${seconds}s: stale=${stale}; widget 30s rule unused`, async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try {
		f.state(true, T("10:00"), "run-a", { owner_heartbeat_at: T("11:59") });
		const s = await readOnce(f, clock(new Date(Date.parse(T("11:59")) + seconds * 1000).toISOString()));
		assert.equal(s.health.stale, stale); assert.equal(s.health.state, stale ? "stale" : "running"); assert.equal(s.health.heartbeatAgeMs, seconds * 1000);
	} finally { f.close(); }
});

test("stopped from fresh state with reason; retained state never gives stopped or counters", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	const reader = openLoop(f.root, { runtime: clock() });
	try {
		f.state(false, T("10:00"), "run-a", { completed_at: T("11:00"), stop_reason: "manual_stop", error_count: 3 });
		const good = await reader.read(); assert.equal(good.health.state, "stopped");
		assert.deepEqual(good.health.stopped, { reason: "manual_stop", at: T("11:00") });
		writeFileSync(path.join(f.root, ".ralph/loop.md"), "---\nrunning: false\n");
		const torn = await reader.read(); assert.equal(torn.sources.state.status, "retained");
		assert.equal(torn.health.state, "unknown"); assert.equal(torn.health.stopped, null); assert.equal(torn.health.counters, null); assert.equal(torn.health.stale, null);
		unlinkSync(path.join(f.root, ".ralph/loop.md"));
		assert.equal((await reader.read()).health.state, "not-started");
	} finally { await reader.close(); f.close(); }
});

test("not-started without state; unknown with torn state", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try { assert.equal((await readOnce(f)).health.state, "not-started");
		writeFileSync(path.join(f.root, ".ralph/loop.md"), "---\nrunning: false\n"); assert.equal((await readOnce(f)).health.state, "unknown");
	} finally { f.close(); }
});

test("snapshot never claims a stall; liveness uses connected event receive time and 30min inclusive boundary", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try {
		f.state(true, T("10:00"), "run-a", { owner_heartbeat_at: T("12:00") });
		const s = await readOnce(f); const now = Date.parse(T("12:00"));
		assert.equal(s.health.stalled, "unavailable");
		for (const live of [null, { connected: false, lastPiAt: T("10:00") }, { connected: true, lastPiAt: null }, { connected: true, lastPiAt: "invalid" }]) {
			assert.deepEqual(deriveLiveness(s, live, now), { stalled: "unavailable", lastEventAgeMs: null, badge: "running" });
		}
		assert.deepEqual(deriveLiveness(s, { connected: true, lastPiAt: T("11:30") }, now), { stalled: true, lastEventAgeMs: 1_800_000, badge: "stalled" });
		assert.equal(deriveLiveness(s, { connected: true, lastPiAt: new Date(now - STALLED_AFTER_MS + 1000).toISOString() }, now).stalled, false);
		assert.equal(deriveLiveness(s, { connected: true, lastPiAt: T("12:00") }, now).stalled, false);
		f.state(false, T("10:00")); assert.equal(deriveLiveness(await readOnce(f), { connected: true, lastPiAt: T("10:00") }, now).stalled, false);
	} finally { f.close(); }
});

test("stalled ignores file times; STALE and STALLED are independent", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try {
		f.state(true, T("10:00"), "run-a", { owner_heartbeat_at: T("11:00") });
		f.journal([{ v: 1, k: "run", r: "L1", t: T("10:00"), m: "m", th: "off", mx: 9, tk: "b" }]);
		for (const file of ["loop.md", "items.json", "journal.jsonl"]) utimesSync(path.join(f.root, ".ralph", file), 0, 0);
		const s = await readOnce(f); assert.equal(s.health.state, "stale"); assert.equal(s.health.stalled, "unavailable");
		assert.equal(deriveLiveness(s, { connected: true, lastPiAt: T("12:00") }, Date.parse(T("12:00"))).stalled, false);
		assert.equal(deriveLiveness(s, { connected: true, lastPiAt: T("11:30") }, Date.parse(T("12:00"))).stalled, true);
	} finally { f.close(); }
});

test("counters rise within a run only and compare previous fresh values", async () => {
	const f = new Fixture([{ id: "A", passes: false }]); const reader = openLoop(f.root, { runtime: clock() });
	try {
		f.state(true, T("10:00"), "run-a", { error_count: 1, bundle_rejection_count: 2 });
		assert.deepEqual((await reader.read()).health.counters, { errors: { value: 1, previous: null, rising: false }, bundleRejections: { value: 2, previous: null, rising: false } });
		writeFileSync(path.join(f.root, ".ralph/loop.md"), "---\nrunning: true\n"); assert.equal((await reader.read()).health.counters, null);
		f.state(true, T("10:00"), "run-a", { error_count: 3, bundle_rejection_count: 3 });
		assert.deepEqual((await reader.read()).health.counters, { errors: { value: 3, previous: 1, rising: true }, bundleRejections: { value: 3, previous: 2, rising: true } });
		f.state(true, T("10:00"), "run-b"); assert.deepEqual((await reader.read()).health.counters?.errors, { value: 0, previous: null, rising: false });
		f.state(true, T("10:00"), "run-b", { error_count: 1 }); assert.deepEqual((await reader.read()).health.counters?.errors, { value: 1, previous: 0, rising: true });
		assert.equal((await reader.read()).health.counters?.errors.rising, false);
	} finally { await reader.close(); f.close(); }
});

test("new launch identity resets counter comparison even with an unchanged loop token", async () => {
	const f = new Fixture([{ id: "A", passes: false }]); const reader = openLoop(f.root, { runtime: clock() });
	try {
		const header = { v: 1, k: "run", r: "L1", t: T("10:00"), m: "m", th: "off", mx: 9, tk: "b" } as const;
		const loop = { v: 1, k: "loop", r: "L1", t: T("10:00"), tok: "run-a", sa: T("10:00"), i: 1, ph: "initialized" } as const;
		f.journal([header, loop]); f.state(true, T("10:00"), "run-a", { error_count: 1 }); await reader.read();
		f.appendJournalRaw(JSON.stringify({ ...header, r: "L2", t: T("11:00") }) + "\n" + JSON.stringify({ ...loop, r: "L2", t: T("11:00") }) + "\n");
		f.state(true, T("10:00"), "run-a", { error_count: 2 });
		assert.deepEqual((await reader.read()).health.counters?.errors, { value: 2, previous: null, rising: false });
	} finally { await reader.close(); f.close(); }
});
