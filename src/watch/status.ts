import { connectEvents, matchingHello } from "./events.js";
import { deriveLiveness } from "./health.js";
import { openLoop, type ObservationRuntime } from "./loop-state.js";
import type { LoopSnapshot } from "./types.js";

/** Authority: owner decision on #7, 2026-10-01. */
const STATUS_HELLO_TIMEOUT_MS = 2_000;
export type StatusRuntime = { readonly observation?: ObservationRuntime; readonly signal?: AbortSignal };
export type StatusResult = { readonly text: string; readonly exitCode: 0 | 3 };

// Keep each field on one line. JSON escaping preserves untrusted text without
// allowing terminal controls, newlines or Unicode line separators to forge fields.
const text = (value: string) => JSON.stringify(value).slice(1, -1).replace(/[\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const flag = (value: boolean | null | "unavailable") => value === null ? "unavailable" : String(value);
const milliseconds = (value: number | null) => value === null ? "unavailable" : `${value} ms`;
const item = (snapshot: LoopSnapshot, key: string | null) => {
	if (key === null) return "n/a";
	const found = snapshot.items.find((i) => i.key === key);
	return text(`${key}${found ? ` ${found.title}` : ""}`);
};

/** Observe once. Neither status nor its reader writes state or sends controls. */
export async function readStatus(root: string, runtime: StatusRuntime = {}): Promise<StatusResult> {
	const reader = openLoop(root, { runtime: runtime.observation });
	try {
		const snapshot = await reader.read(runtime.signal);
		const warnings = snapshot.issues.map((i) => `${i.source} ${i.kind}: ${i.detail}`);
		for (const [source, report] of Object.entries(snapshot.sources)) {
			if (report.status !== "fresh" && report.status !== "not-applicable") warnings.push(`${source} ${report.status}${report.error ? `: ${report.error}` : ""}`);
		}
		if (snapshot.enforcer && ["down", "unavailable"].includes(snapshot.enforcer.status.state)) warnings.push(`enforcer: ${snapshot.enforcer.status.state}`);
		if (!snapshot.timeline.coverage.complete) warnings.push(`timing: ${snapshot.timeline.coverage.reason ?? "unavailable"}`);
		let liveness = deriveLiveness(snapshot, null, snapshot.observedAt ? Date.parse(snapshot.observedAt) : Date.now());
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(new Error("Driver hello unavailable after 2 s")), STATUS_HELLO_TIMEOUT_MS);
		const signal = runtime.signal ? AbortSignal.any([runtime.signal, abort.signal]) : abort.signal;
		const frames = connectEvents({ root: snapshot.root, run: snapshot.run }, signal)[Symbol.asyncIterator]();
		try {
			const first = await frames.next();
			if (signal.aborted) throw signal.reason;
			if (first.done || first.value.type !== "hello") throw new Error("Driver hello unavailable");
			const hello = first.value;
			liveness = deriveLiveness(snapshot, matchingHello(snapshot, hello), runtime.observation?.now() ?? new Date());
			if (liveness.stalled === "unavailable") warnings.push("activity: driver has no event receive time");
		} catch (error) {
			warnings.push(`activity unavailable: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			clearTimeout(timer);
			abort.abort();
			await frames.return?.();
		}
		if (runtime.signal?.aborted) throw runtime.signal.reason ?? new Error("Status aborted");
		const { eta } = snapshot.timeline;
		const complete = warnings.length === 0 && liveness.stalled !== "unavailable";
		const progress = snapshot.task === "plain" ? "not-applicable" : snapshot.task === "bundle" && snapshot.sources.items.status === "fresh" ? `${snapshot.items.filter((i) => i.passes).length}/${snapshot.items.length} passed` : "unavailable";
		const lines = [
			`root: ${text(snapshot.root)}`,
			`observed at: ${text(snapshot.observedAt)}`,
			`task: ${snapshot.task ?? "unavailable"}`,
			`items: ${progress}`,
			`current item: ${item(snapshot, snapshot.currentItem)}`,
			`stopped item: ${item(snapshot, snapshot.stoppedItem)}`,
			`health: ${liveness.badge.toUpperCase()}`,
			`enforcer: ${snapshot.enforcer?.status.state ?? "unavailable"}`,
			`stale: ${flag(snapshot.health.stale)}`,
			`stalled: ${flag(liveness.stalled)}`,
			`heartbeat age: ${milliseconds(snapshot.health.heartbeatAgeMs)}`,
			`activity: ${liveness.lastEventAgeMs === null ? "unavailable" : "available"}`,
			`event age: ${milliseconds(liveness.lastEventAgeMs)}`,
			`stop reason: ${snapshot.health.stopped?.reason == null ? "n/a" : text(snapshot.health.stopped.reason)}`,
			`ETA: ${eta.estimateMs === null ? "n/a" : `estimate ${eta.estimateMs} ms`}; n=${eta.n}`,
			`timing coverage: ${snapshot.timeline.coverage.complete ? "complete" : "unavailable"}`,
			`coverage: ${complete ? "complete" : "partial"}`,
			...warnings.map((warning) => `warning: ${text(warning)}`),
		];
		return { text: lines.join("\n"), exitCode: complete ? 0 : 3 };
	} finally { await reader.close(); }
}
