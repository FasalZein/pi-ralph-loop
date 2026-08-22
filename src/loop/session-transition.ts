// Session-transition coordinator ──────────────────────────────────────
// Pi reports a session idle before it drains the final agent_settled
// extension handlers, and it invalidates the old extension ctx during a
// session replacement. A replacement that lands while that drain is still
// running can hand a later handler in another extension a stale ctx.
//
// The boundary Ralph needs is "the settle drain finished". Capturing
// ctx.waitForIdle() synchronously while handling agent_end — while the
// session still reports an active run — gives exactly that: the captured
// promise resolves in Pi's _emitAgentSettled finally, after every
// agent_settled handler (including continuations queued behind the turn)
// has returned. Replacements dispatch once both (a) that promise resolved
// and (b) their own due time arrived.
//
// Stored on globalThis because pi reloads extension modules on newSession(),
// which would reset module-level state between iterations.
const STORE_KEY = "__ralph_loop_session_transition__";

const TEST_SHUTDOWN_GRACE_ENV = "RALPH_TEST_SESSION_SHUTDOWN_GRACE_MS";
// Bounded grace held in Ralph's session_shutdown handler during an authorized
// replacement. Handlers that return normally can still have left detached
// work reading the ctx slightly later; this keeps the outgoing ctx alive a
// little longer so short deferred work lands on a live context. It is a
// heuristic, not a correctness barrier: work longer than the grace can still
// observe a stale ctx.
const SESSION_SHUTDOWN_GRACE_MS = 100;

type PendingReplacement = {
	execute: () => void;
	settled: boolean;
	due: boolean;
};

type TransitionStore = {
	epoch: number;
	pending: PendingReplacement | null;
	replacementInFlight: boolean;
};

function store(): TransitionStore {
	const globals = globalThis as Record<string, unknown>;
	const existing = globals[STORE_KEY] as TransitionStore | undefined;
	if (existing) return existing;
	const created: TransitionStore = {
		epoch: 0,
		pending: null,
		replacementInFlight: false,
	};
	globals[STORE_KEY] = created;
	return created;
}

/** How long Ralph's shutdown handler holds an authorized replacement open. */
export function getSessionShutdownGraceMs(): number {
	const raw = process.env[TEST_SHUTDOWN_GRACE_ENV];
	if (!raw) return SESSION_SHUTDOWN_GRACE_MS;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0
		? parsed
		: SESSION_SHUTDOWN_GRACE_MS;
}

/**
 * Register a fresh-session replacement.
 *
 * `idle` must be a promise captured via ctx.waitForIdle() while the outgoing
 * run was still active (see the module note); pass null when no run was in
 * flight, which dispatches on the due time alone. The executor re-validates
 * loop state when it runs, so a stale dispatch cannot act on obsolete state.
 */
export function armSessionReplacement(
	execute: () => void,
	options: { idle: Promise<void> | null },
): void {
	const s = store();
	clearPendingSessionReplacement();
	const pending: PendingReplacement = {
		execute,
		settled: options.idle === null,
		due: false,
	};
	s.pending = pending;
	if (options.idle !== null) {
		const epoch = s.epoch;
		const onIdleDone = () => {
			if (store().epoch !== epoch || s.pending !== pending) return;
			pending.settled = true;
			dispatchIfReady(s, pending);
		};
		options.idle.then(onIdleDone, onIdleDone);
	}
}

/** Mark the armed replacement as due (its countdown/wait completed). */
export function markReplacementDue(): void {
	const s = store();
	if (!s.pending) return;
	s.pending.due = true;
	dispatchIfReady(s, s.pending);
}

function dispatchIfReady(s: TransitionStore, pending: PendingReplacement): void {
	if (!pending.settled || !pending.due) return;
	s.pending = null;
	pending.execute();
}

/**
 * Mark the sole authorized replacement window. Ralph's session_before_switch
 * guard only allows reason "new" while this is true, and the shutdown grace
 * only applies inside it.
 */
export function beginReplacement(): void {
	store().replacementInFlight = true;
}

export function endReplacement(): void {
	store().replacementInFlight = false;
}

export function isReplacementInFlight(): boolean {
	return store().replacementInFlight;
}

/** Drop any armed replacement and close the authorization window. */
export function clearPendingSessionReplacement(): void {
	const s = store();
	s.epoch += 1;
	s.pending = null;
	s.replacementInFlight = false;
}
