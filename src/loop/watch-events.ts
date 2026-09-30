// Ralph Watch telemetry producer ─────────────────────────────────────
// The loop engine observes its own real decisions (iteration entry, promise
// gate results, accepted handoff, finalization) and publishes them as
// best-effort facts to a launcher-owned local socket. Telemetry never
// changes loop semantics: publishLoopFact is synchronous in signature,
// never throws, never awaits delivery, and is a no-op without a channel.
//
// Channel contract (consumed by the Ralph Watch driver):
// - RALPH_WATCH_FACT_SOCKET: absolute path of a Unix stream socket the
//   launcher binds before it spawns pi. Absent or relative → no-op.
// - RALPH_WATCH_LAUNCH_ID: launcher identity copied into every fact; null
//   when absent.
// - Frames are newline-delimited JSON:
//   {"version":1,"id":string,"sequence":number,"fact":LoopFact}
//   `sequence` counts publication attempts per launch/loop token, including
//   frames dropped by the transport, so a gap exposes loss. `id` is
//   JSON.stringify([launchId, loopToken, sequence]).
// - Delivery is best effort: frames written while the socket connects are
//   buffered by Node; frames are dropped after a connection error, after
//   close, or while a write waits for drain. There is no retry, timer or
//   acknowledgment.
//
// Counters and the socket live on globalThis because pi reloads extension
// modules on newSession(), which would reset module-level state.
import { connect, type Socket } from "node:net";
import { isAbsolute } from "node:path";

import { readStateDocument } from "../state.js";
import type { RalphLoopState } from "../types.js";
import type { ControlPromise } from "./control-promise.js";

export const FACT_SOCKET_ENV = "RALPH_WATCH_FACT_SOCKET";
export const LAUNCH_ID_ENV = "RALPH_WATCH_LAUNCH_ID";
export const LOOP_FACT_VERSION = 1;

/** Identity of the loop run a fact belongs to. */
export type LoopFactRun = {
	readonly launchId: string | null;
	readonly loopToken: string;
	readonly startedAt: string;
};

/**
 * The kind-specific part of a fact.
 * - iteration-start: `initialized` observes run creation, `entered` a
 *   successful session entry (also same-iteration fallback and continue),
 *   `resumed` reactivation without a fresh seed prompt. All three share one
 *   run/token/iteration identity.
 * - promise-decision: the real gate result; `reason` is the exact rejection
 *   text or null when accepted.
 * - iteration-end: an accepted NEXT handoff was committed (old iteration).
 * - loop-ended: the loop reached a terminal state.
 */
export const ITERATION_START_PHASES = ["initialized", "entered", "resumed"] as const;
export type LoopFactDetail =
	| {
			readonly kind: "iteration-start";
			readonly phase: (typeof ITERATION_START_PHASES)[number];
	  }
	| {
			readonly kind: "promise-decision";
			readonly promise: ControlPromise;
			readonly accepted: boolean;
			readonly reason: string | null;
	  }
	| { readonly kind: "iteration-end"; readonly outcome: "NEXT" }
	| {
			readonly kind: "loop-ended";
			readonly reason: RalphLoopState["stop_reason"];
	  };

export type LoopFact = {
	readonly run: LoopFactRun;
	readonly iteration: number;
	/** ISO timestamp captured when the engine published the fact. */
	readonly at: string;
} & LoopFactDetail;

export type LoopFactEnvelope = {
	readonly version: typeof LOOP_FACT_VERSION;
	readonly id: string;
	readonly sequence: number;
	readonly fact: LoopFact;
};

/** Private delivery seam; tests replace it with a recording receiver. */
export type LoopFactTransport = (envelope: LoopFactEnvelope) => void;

type SocketChannel = {
	path: string;
	socket: Socket;
	draining: boolean;
};

type WatchEventsStore = {
	sequences: Map<string, number>;
	channel: SocketChannel | null;
	testTransport: LoopFactTransport | null;
};

const STORE_KEY = "__ralph_loop_watch_events__";

function store(): WatchEventsStore {
	const globals = globalThis as Record<string, unknown>;
	const existing = globals[STORE_KEY] as WatchEventsStore | undefined;
	if (existing) return existing;
	const created: WatchEventsStore = {
		sequences: new Map(),
		channel: null,
		testTransport: null,
	};
	globals[STORE_KEY] = created;
	return created;
}

function configuredSocketPath(): string | null {
	const path = process.env[FACT_SOCKET_ENV];
	return path && isAbsolute(path) ? path : null;
}

/** True when a publication would be attempted. Cheap; never throws. */
export function isLoopFactChannelConfigured(): boolean {
	return store().testTransport !== null || configuredSocketPath() !== null;
}

/**
 * Telemetry-only observation of the saved state. Returns null without a
 * channel, when the file is missing or incomplete (so identity is never
 * invented), or when the read fails. Never throws.
 */
export function readStateForTelemetry(cwd: string): RalphLoopState | null {
	if (!isLoopFactChannelConfigured()) return null;
	try {
		const document = readStateDocument(cwd);
		return document.status === "valid" ? document.state : null;
	} catch {
		return null;
	}
}

/**
 * The only publication path the engine uses. Invariant: a fact is published
 * only after the complete saved state document confirms both the run identity
 * (loop_token and started_at equal the engine's in-memory run) and the
 * transition the fact describes (`confirms`). The engine can hold a token that
 * readState invented for a legacy file, and updateState silently skips its
 * write when its own read fails, so neither the in-memory state nor a preceding
 * write call is evidence. Unconfirmed facts are omitted, not repaired. Returns
 * before any file read without a channel. Never throws.
 */
export function publishConfirmedFact(
	cwd: string,
	state: RalphLoopState,
	detail: LoopFactDetail,
	confirms: (saved: RalphLoopState) => boolean,
): void {
	try {
		const saved = readStateForTelemetry(cwd);
		if (
			!saved ||
			saved.loop_token !== state.loop_token ||
			saved.started_at !== state.started_at ||
			!confirms(saved)
		) {
			return;
		}
		publishLoopFact(state, detail);
	} catch {
		// Telemetry is best effort; the loop must not observe its failure.
	}
}

/** Test seam: route envelopes to a recording receiver, or null to reset. */
export function setLoopFactTransportForTests(
	transport: LoopFactTransport | null,
): void {
	store().testTransport = transport;
}

function closeChannel(s: WatchEventsStore, channel: SocketChannel): void {
	if (s.channel === channel) s.channel = null;
	channel.socket.destroy();
}

function openChannel(s: WatchEventsStore, path: string): SocketChannel {
	const socket = connect({ path });
	const channel: SocketChannel = { path, socket, draining: false };
	// Listeners go on before any write so an async failure is never unhandled.
	socket.on("error", () => closeChannel(s, channel));
	socket.on("close", () => closeChannel(s, channel));
	socket.on("drain", () => {
		channel.draining = false;
	});
	// Telemetry must never keep pi alive.
	socket.unref();
	s.channel = channel;
	return channel;
}

function sendToSocket(s: WatchEventsStore, path: string, line: string): void {
	let channel = s.channel;
	if (channel && channel.path !== path) {
		closeChannel(s, channel);
		channel = null;
	}
	channel ??= openChannel(s, path);
	if (channel.draining || channel.socket.destroyed) return;
	if (!channel.socket.write(line)) channel.draining = true;
}

/**
 * Publish one loop fact. Never throws and never blocks the engine; without a
 * channel it returns before any identity, clock or encoding work.
 */
export function publishLoopFact(
	state: RalphLoopState,
	detail: LoopFactDetail,
): void {
	try {
		const s = store();
		const path = s.testTransport ? null : configuredSocketPath();
		if (!s.testTransport && !path) return;

		const launchId = process.env[LAUNCH_ID_ENV] || null;
		const sequenceKey = JSON.stringify([launchId, state.loop_token]);
		const sequence = (s.sequences.get(sequenceKey) ?? 0) + 1;
		s.sequences.set(sequenceKey, sequence);
		const envelope: LoopFactEnvelope = {
			version: LOOP_FACT_VERSION,
			id: JSON.stringify([launchId, state.loop_token, sequence]),
			sequence,
			fact: {
				run: {
					launchId,
					loopToken: state.loop_token,
					startedAt: state.started_at,
				},
				iteration: state.iteration,
				at: new Date().toISOString(),
				...detail,
			},
		};

		if (s.testTransport) {
			s.testTransport(envelope);
			return;
		}
		if (path) sendToSocket(s, path, `${JSON.stringify(envelope)}\n`);
	} catch {
		// Telemetry is best effort; the loop must not observe its failure.
	}
}
