import type { ITERATION_START_PHASES } from "../loop/watch-events.js";
import type { JournalWriter } from "./journal.js";
import { emptyTotals, type RpcMonitor } from "./rpc.js";
import { parseFact, type Broadcast } from "./transport.js";
import type { EventFrame, JournalRecord } from "./types.js";

type Loop = NonNullable<Extract<EventFrame, { type: "hello" }>["loop"]>;
type StartPhase = (typeof ITERATION_START_PHASES)[number];
export type FactHooks = {
	readonly launchId: string;
	readonly monitor: RpcMonitor;
	readonly journal: () => JournalWriter | null;
	readonly base: () => { v: 1; t: string; r: string };
	readonly publish: (frame: Broadcast) => void;
	readonly driverFact: (e: Extract<JournalRecord, { k: "d" }>["e"], why?: string) => void;
	/** First matching iteration-start fact after `expectLaunch`. */
	readonly onLaunched: () => void;
	readonly onLoopEnded: (token: string) => void;
};

/** Fact sequence, loop identity, usage flushes and launch confirmation for one driver. */
export class FactTracker {
	loop: Loop | null = null;
	readonly endedTokens = new Set<string>();
	private readonly lastSequences = new Map<string, number>();
	private confirming: ReadonlySet<StartPhase> | null = null;
	constructor(private readonly hooks: FactHooks) {}
	get launchPending(): boolean { return this.confirming !== null; }
	/** Arm launch confirmation for the given iteration-start phases. */
	expectLaunch(phases: readonly StartPhase[]): void { this.confirming = new Set(phases); }
	cancelLaunch(): void { this.confirming = null; }
	flushUsage(): void {
		const { monitor } = this.hooks;
		const totals = monitor.totals;
		if (Object.values(totals).some((value) => value !== 0)) this.hooks.journal()?.append({ ...this.hooks.base(), k: "u", tok: this.loop?.token ?? null, i: this.loop?.iteration ?? 1, in: totals.input, out: totals.output, cr: totals.cacheRead, cw: totals.cacheWrite, c: Number(totals.costUsd.toFixed(6)), n: totals.messages, dc: totals.dialogsCancelled, pr: totals.refusals });
		monitor.totals = emptyTotals();
	}
	receive(line: string): void {
		const { monitor, publish } = this.hooks;
		const journal = this.hooks.journal();
		const envelope = parseFact(line);
		if (!envelope || envelope.fact.run.launchId !== this.hooks.launchId) { monitor.counters.badFacts++; return; }
		const fact = envelope.fact;
		const key = JSON.stringify([fact.run.launchId, fact.run.loopToken]);
		const last = this.lastSequences.get(key) ?? 0;
		if (envelope.sequence <= last) return;
		if (envelope.sequence > last + 1) { publish({ type: "gap", source: "facts", from: last + 1, to: envelope.sequence - 1 }); this.hooks.driverFact("gap", `${last + 1}-${envelope.sequence - 1}`); }
		this.lastSequences.set(key, envelope.sequence);
		if (!this.loop || this.loop.token !== fact.run.loopToken || this.loop.iteration !== fact.iteration) {
			this.flushUsage(); monitor.resetIteration();
		}
		const loop = this.loop = { token: fact.run.loopToken, startedAt: fact.run.startedAt, iteration: fact.iteration };
		if (fact.kind === "iteration-start" && (fact.phase === "initialized" || fact.phase === "resumed")) journal?.append({ ...this.hooks.base(), k: "loop", tok: loop.token, sa: loop.startedAt, i: loop.iteration, ph: fact.phase });
		if (fact.kind === "promise-decision") journal?.append({ ...this.hooks.base(), k: "g", tok: loop.token, i: loop.iteration, p: fact.promise, ok: fact.accepted ? 1 : 0, ...(fact.reason ? { why: fact.reason.slice(0, 100) } : {}) });
		if (fact.kind === "iteration-end") this.flushUsage();
		publish({ type: "event", event: { kind: "fact", fact } });
		if (this.confirming && fact.kind === "iteration-start" && this.confirming.has(fact.phase)) {
			this.confirming = null;
			this.hooks.onLaunched();
		}
		if (fact.kind === "loop-ended") {
			this.endedTokens.add(loop.token);
			this.hooks.onLoopEnded(loop.token);
		}
	}
}
