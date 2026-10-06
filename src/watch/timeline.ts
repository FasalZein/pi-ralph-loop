import type { RalphLoopState } from "../types.js";
import type { Alert, Boundary, CommitEvent, IterationEntry, Duration, Issue, JournalView, ObservedItem, RunStart, Span, Timeline } from "./types.js";

/** Timing uses fresh facts only. Unknown coverage is not a zero-length interval. */
export function deriveTimeline(input: {
	commits: readonly CommitEvent[] | null; runs: readonly RunStart[]; journal: JournalView | null;
	state: RalphLoopState | null; items: readonly ObservedItem[]; item: string | null; now: string;
}): { timeline: Timeline; issues: Issue[] } {
	const { commits, runs, journal, state, items, item, now } = input;
	const issues: Issue[] = [];
	const boundaries: Boundary[] = runs.map((r) => ({ at: r.startedAt, kind: "run-start", sha: null, item: null }));
	for (const c of commits ?? []) {
		if (c.kind !== "other" && c.committedAt !== null) boundaries.push({ at: c.committedAt, kind: c.kind, sha: c.sha, item: c.kind === "blocker" ? c.blockerItem : c.passedItems[0] ?? null });
	}
	boundaries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
	const stopped: Span[] = [];
	let pending: Span | null = null;
	let launch: string | null = null;
	let lastAt: string | null = null;
	let stoppedLaunch = false;
	for (const record of journal?.records ?? []) {
		if (record.k === "run" && launch !== record.r) {
			if (launch && !stoppedLaunch && lastAt && !pending) pending = { from: lastAt, to: null, known: false };
			launch = record.r;
			stoppedLaunch = false;
		}
		if (record.k === "d" && (record.e === "exit" || record.e === "pi-exit")) {
			if (!pending) pending = { from: record.t, to: null, known: true };
			stoppedLaunch = true;
		}
		if (record.k === "loop" && pending && Date.parse(record.t) >= Date.parse(pending.from)) {
			stopped.push({ ...pending, to: record.t });
			pending = null;
		}
		lastAt = record.t;
	}
	if (state && !state.running && state.completed_at && Number.isFinite(Date.parse(state.completed_at))) {
		// A driver exit after completed_at is the same stop, not a second interval.
		if (!pending || Date.parse(state.completed_at) < Date.parse(pending.from)) pending = { from: state.completed_at, to: null, known: true };
	}
	if (pending) stopped.push(pending);
	const start = journal?.coverageStart ?? null;
	const earliest = boundaries[0]?.at ?? commits?.[0]?.committedAt ?? state?.started_at ?? null;
	const reason = !journal ? "journal unavailable" : journal.rotated ? "rotated journal present; older history may be lost"
		: journal.badLines ? "bad journal lines; history incomplete"
		: journal.records[0]?.k !== "run" ? "journal does not begin with a run"
		: !commits ? "history unavailable"
		: start === null || (earliest !== null && Date.parse(start) > Date.parse(earliest)) ? "journal starts after needed boundary"
		: journal.records.some((r) => r.k === "d" && r.e === "gap") ? "journal gap"
		: stopped.some((s) => !s.known) ? "unknown stop" : null;
	const coverage = { start, complete: reason === null, reason };
	const active = (from: string, to: string): { ms: number; reason: null } | { ms: null; reason: string } => {
		const x = Date.parse(from), y = Date.parse(to);
		if (!Number.isFinite(x) || !Number.isFinite(y) || y < x) return { ms: null, reason: "invalid or reversed timing boundary" };
		if (!journal || start === null || x < Date.parse(start)) return { ms: null, reason: "interval starts before journal coverage" };
		// Corrupt lines and explicit loss can hide stops anywhere in this retained range.
		if (journal.badLines || journal.records.some((r) => r.k === "d" && r.e === "gap" && Date.parse(r.t) >= x && Date.parse(r.t) <= y)) return { ms: null, reason: "journal gap or invalid line in timing coverage" };
		let ms = y - x;
		for (const span of stopped) {
			const overlap = Math.max(0, Math.min(y, span.to === null ? y : Date.parse(span.to)) - Math.max(x, Date.parse(span.from)));
			if (overlap > 0 && !span.known) return { ms: null, reason: "unknown stop in interval" };
			ms -= overlap;
		}
		return { ms, reason: null };
	};
	const durations: Record<string, Duration> = Object.create(null);
	const passed = new Set(items.filter((i) => i.passes).map((i) => i.key));
	for (const [index, c] of (commits ?? []).entries()) {
		if (c.kind !== "item-pass") continue;
		const previous = c.committedAt === null ? undefined : boundaries.filter((b) => Date.parse(b.at) < Date.parse(c.committedAt!)).at(-1);
		// Graph predecessors catch clock skew that sorting boundaries would conceal.
		const graphPrevious = (commits ?? []).slice(0, index).filter((b) => b.kind !== "other" && b.committedAt !== null).at(-1);
		const reversed = c.committedAt !== null && ((graphPrevious?.committedAt && Date.parse(graphPrevious.committedAt) > Date.parse(c.committedAt)) || (!previous && runs.some((r) => Date.parse(r.startedAt) > Date.parse(c.committedAt!))));
		const fromIndex = previous?.sha ? (commits ?? []).findIndex((b) => b.sha === previous.sha) : -1;
		const nonlinear = (commits ?? []).slice(fromIndex + 1, index + 1).some((b) => (b.committedAt === null || !previous || Date.parse(b.committedAt) > Date.parse(previous.at)) && (b.parents.length > 1 || !b.passesKnown || b.committedAt === null));
		const failure = c.passedItems.length !== 1 ? "commit flips multiple items" : !c.passesKnown ? "pass evidence unknown" : c.committedAt === null ? "commit time unavailable" : reversed ? "commit time earlier than previous boundary" : nonlinear ? "nonlinear or unknown commit range" : !previous ? "previous boundary unavailable" : null;
		const measured = failure || !previous || c.committedAt === null ? { ms: null, reason: failure ?? "previous boundary unavailable" } : active(previous.at, c.committedAt);
		if (measured.ms === null) issues.push({ source: "timeline", kind: "partial", detail: `${c.sha}: ${measured.reason}` });
		for (const key of c.passedItems) if (passed.has(key)) durations[key] = measured.ms === null ? { ms: null, reason: measured.reason! } : { ms: measured.ms, from: previous!.at, to: c.committedAt!, sha: c.sha };
	}
	for (const key of passed) if (!durations[key]) durations[key] = { ms: null, reason: "pass timing evidence unavailable" };
	const since = boundaries.filter((b) => Date.parse(b.at) <= Date.parse(now)).at(-1);
	const current = since ? active(since.at, now) : { ms: null, reason: "previous boundary unavailable" };
	const currentItem: Timeline["currentItem"] = !item ? null : current.ms === null || !since ? { key: item, ms: null, reason: current.reason ?? "previous boundary unavailable" } : { key: item, since, ms: current.ms };
	const elapsed = state && Number.isFinite(Date.parse(state.started_at)) ? { wallMs: Math.max(0, Date.parse(now) - Date.parse(state.started_at)), activeMs: active(state.started_at, now).ms } : null;
	const values = Object.values(durations).flatMap((d) => d.ms === null ? [] : [d.ms]).sort((a, b) => a - b);
	const n = values.length;
	const median = n === 0 ? null : n % 2 ? values[Math.floor(n / 2)] : (values[n / 2 - 1] + values[n / 2]) / 2;
	const itemsLeft = items.filter((i) => !i.passes).length;
	return { timeline: { coverage, boundaries, stopped, elapsed, currentItem, durations, eta: { estimateMs: median === null ? null : median * itemsLeft, n, itemsLeft } }, issues };
}

/** Owner Q2 on #17: correlate by commit time; never guess a SHA from ambiguous evidence. */
export function deriveIterations(input: {
	journal: JournalView | null; commits: readonly CommitEvent[] | null; alerts: readonly Alert[]; items?: readonly ObservedItem[];
}): readonly IterationEntry[] | null {
	const { journal, commits, alerts, items = [] } = input;
	if (!journal) return null;
	const entries: IterationEntry[] = [];
	let boundary: { at: string; launch: string; token: string } | null = null;
	let startedAt: string | null = null;
	const incomplete = journal.rotated || journal.badLines > 0 || journal.records[0]?.k !== "run" || journal.records.some((r) => r.k === "d" && r.e === "gap");
	if (incomplete) entries.push({ kind: "incomplete", at: journal.coverageStart ?? "", reason: "history incomplete" });
	const ordered = commits !== null && commits.every((c, i) => c.committedAt !== null && c.parents.length === 1 && (i === 0 || Date.parse(c.committedAt) >= Date.parse(commits[i - 1].committedAt!)));
	for (const r of journal.records) {
		if (r.k === "loop") {
			entries.push({ kind: "run", at: r.t, token: r.tok, phase: r.ph });
			boundary = { at: r.t, launch: r.r, token: r.tok };
			startedAt = r.sa;
		} else if (r.k === "x") entries.push({ kind: "intervention", at: r.t, op: r.op, accepted: r.ok === 1, reason: r.why ?? null });
		else if (r.k === "g") {
			const from: number | null = boundary && boundary.launch === r.r && boundary.token === r.tok ? Date.parse(boundary.at) : null;
			const candidates = from === null ? [] : (commits ?? []).filter((c) => c.committedAt !== null && Date.parse(c.committedAt) > from && Date.parse(c.committedAt) < Date.parse(r.t));
			const c = !incomplete && ordered && candidates.length === 1 && candidates[0].passesKnown ? candidates[0] : null;
			const commit = c?.sha ?? null;
			// Rebuild pending items at the gate from pass commits. Already-passed items without
			// a flip in base..HEAD were passed before this observed history.
			const pending = !incomplete && ordered ? items.find((item) => {
				const flips = (commits ?? []).filter((c) => c.passedItems.includes(item.key));
				return (!item.passes || flips.length > 0) && !flips.some((c) => c.committedAt !== null && Date.parse(c.committedAt) <= Date.parse(r.t));
			})?.key ?? null : null;
			const marks: ("rejection" | "enforcer")[] = r.ok === 0 ? ["rejection"] : [];
			if (commit && alerts.some((a) => a.commit === commit && a.run.launchId === r.r && a.run.loopToken === r.tok && a.run.startedAt === startedAt)) marks.push("enforcer");
			entries.push({ kind: "gate", at: r.t, iteration: r.i, promise: r.p, item: c?.passedItems.length === 1 ? c.passedItems[0] : c?.blockerItem ?? pending, commit, accepted: r.ok === 1, reason: r.why ?? null, marks });
			boundary = { at: r.t, launch: r.r, token: r.tok };
			if (from === null) startedAt = null;
		}
	}
	for (const c of commits ?? []) if (c.kind === "parent" && c.committedAt !== null) entries.push({ kind: "parent", at: c.committedAt, commit: c.sha, reason: c.parentReason });
	return entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
