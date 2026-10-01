import { LOOP_OWNER_STALE_AFTER_MS } from "../loop/ownership.js";
import { isHeartbeatStale } from "../loop/status-model.js";
import type { RalphLoopState } from "../types.js";
import type { Counter, Health, JournalView, LoopSnapshot } from "./types.js";

// Authority: owner, 2026-09-30 (spec #1). Independent of legacy session heuristics.
export const STALLED_AFTER_MS = 30 * 60_000;
export type CounterBaseline = { readonly launchId: string | null; readonly loopToken: string; readonly startedAt: string; readonly errors: number; readonly bundleRejections: number };
const age = (at: string | null, now: number): number | null => at !== null && Number.isFinite(Date.parse(at)) ? Math.max(0, now - Date.parse(at)) : null;

export function deriveHealth(state: RalphLoopState | null, missing: boolean, journal: JournalView | null, now: number, previous: CounterBaseline | null, launchId: string | null): Health {
	const baseline = state && previous && previous.launchId === launchId && previous.loopToken === state.loop_token && previous.startedAt === state.started_at ? previous : null;
	const counter = (value: number, before: number | null): Counter => ({ value, previous: before, rising: before !== null && value > before });
	const stale = state ? state.running && isHeartbeatStale(state.owner_heartbeat_at, now, LOOP_OWNER_STALE_AFTER_MS) : null;
	return {
		state: !state ? missing ? "not-started" : "unknown" : !state.running ? "stopped" : stale ? "stale" : "running",
		heartbeatAgeMs: state ? age(state.owner_heartbeat_at, now) : null,
		stale,
		stopped: state && !state.running ? { reason: state.stop_reason, at: state.completed_at } : null,
		lastJournalAt: journal?.records.at(-1)?.t ?? null,
		stalled: "unavailable",
		counters: state ? {
			errors: counter(state.error_count, baseline?.errors ?? null),
			bundleRejections: counter(state.bundle_rejection_count, baseline?.bundleRejections ?? null),
		} : null,
	};
}

/** Live receive times are the only stall authority. A disconnected stream proves nothing. */
export function deriveLiveness(snapshot: LoopSnapshot, live: { readonly connected: boolean; readonly lastPiAt: string | null } | null, now: number | Date): {
	stalled: boolean | "unavailable"; lastEventAgeMs: number | null; badge: Health["state"] | "stalled";
} {
	const lastEventAgeMs = live?.connected ? age(live.lastPiAt, Number(now)) : null;
	const running = snapshot.health.state === "running" || snapshot.health.state === "stale";
	const stalled = lastEventAgeMs === null ? "unavailable" : running && lastEventAgeMs >= STALLED_AFTER_MS;
	return { stalled, lastEventAgeMs, badge: stalled === true ? "stalled" : snapshot.health.state };
}
