import { stripVTControlCharacters } from "node:util";

const ITEM_HEADING = /^(\S+)\s+(passed|blocked)\b:?\s*(.*?)\s*(?:\((\d{4}-\d{2}-\d{2})\))?$/i;

export type Outcome = "passed" | "blocked" | "unknown";

export type CardFields = {
	readonly failed?: { readonly cmd: string; readonly exit: number | null; readonly error: string | null };
	readonly cause?: string;
	readonly tried?: string;
	readonly decide?: string;
	readonly proof?: { readonly identical: number; readonly total: number };
	readonly checks: readonly { readonly cmd: string; readonly exits: readonly number[]; readonly detail: string | null }[];
	readonly counts: readonly { readonly label: string; readonly from: string; readonly to: string }[];
	readonly diff?: string;
	readonly assumed: readonly string[];
	readonly notRun: readonly string[];
	readonly evidence: readonly string[];
	readonly why?: string;
};

export type AttemptCard = {
	readonly index: number;
	readonly id: string | null;
	readonly outcome: Outcome;
	readonly title: string;
	readonly date: string | null;
	/** Unsanitized evidence, with CRLF normalized. Sanitize before terminal display. */
	readonly raw: string;
	readonly fields: CardFields | null;
	/** File index of the next successful attempt for this blocked item. */
	readonly resolvedBy: number | null;
};

/** Pure, tolerant parsing of append-only, free-form handoff entries. */
export function parseProgress(text: string): readonly AttemptCard[] {
	const normalized = text.replace(/\r\n/g, "\n");
	if (!normalized.trim()) return [];
	const cards: AttemptCard[] = [];
	let start = 0;
	let offset = 0;
	let fenceLength: number | null = null;
	let entryLevel = 0;
	let itemEntry = false;
	const raws: string[] = [];
	const push = (raw: string) => { raws.push(raw); };
	for (const line of normalized.split("\n")) {
		const marker = fenceMarker(line, fenceLength);
		if (marker !== null) fenceLength = fenceLength === null ? marker : null;
		else if (fenceLength === null) {
			const heading = line.match(/^(#{1,6})\s+(\S.*)$/);
			if (heading) {
				const isItem = ITEM_HEADING.test(clean(heading[2].slice(0, MAX_ANALYSIS_LENGTH)).trim());
				const level = heading[1].length;
				if (!itemEntry || isItem || level <= entryLevel) {
					if (offset > start && normalized.slice(start, offset).trim()) {
						push(normalized.slice(start, offset));
					}
					start = offset;
					entryLevel = level;
					itemEntry = isItem;
				}
			}
		}
		offset += line.length + 1;
	}
	if (normalized.slice(start).trim()) push(normalized.slice(start));
	// Owner Q4 on #16: the file budget is spent newest entry first, so the entries an operator reads
	// first (current item, latest blocker) keep their fields; the oldest entries become heading-only.
	let budget = MAX_FILE_ANALYSIS_LENGTH;
	for (let i = raws.length - 1; i >= 0; i--) {
		cards[i] = parseEntry(raws[i], i, budget);
		budget -= Math.min(raws[i].length, MAX_ENTRY_ANALYSIS_LENGTH);
	}
	const laterPass = new Map<string, number>();
	for (let i = cards.length - 1; i >= 0; i--) {
		const card = cards[i];
		if (card.id === null) continue;
		if (card.outcome === "passed") laterPass.set(card.id, card.index);
		else if (card.outcome === "blocked") cards[i] = { ...card, resolvedBy: laterPass.get(card.id) ?? null };
	}
	return cards;
}

export function latestCard(cards: readonly AttemptCard[]): AttemptCard | null {
	return cards.at(-1) ?? null;
}

function parseEntry(raw: string, index: number, budget: number): AttemptCard {
	const heading = clean(raw.split("\n", 1)[0].slice(0, MAX_ANALYSIS_LENGTH)).match(/^#{1,6}\s+(.+?)\s*$/)?.[1];
	const item = heading?.match(ITEM_HEADING);
	return {
		index, id: item?.[1] ?? null,
		outcome: item ? (item[2].toLowerCase() === "passed" ? "passed" : "blocked") : "unknown",
		title: item?.[3] ?? heading ?? "", date: item?.[4] ?? null,
		raw, fields: heading && budget > 0 ? safeAnalyse(raw.slice(0, Math.min(budget, MAX_ENTRY_ANALYSIS_LENGTH))) : null, resolvedBy: null,
	};
}

// Bound both line and total entry analysis; later fields remain available in raw.
const MAX_ANALYSIS_LENGTH = 8_000;
const MAX_ENTRY_ANALYSIS_LENGTH = 64 * 1_024;
// Shared heuristic allowance for the whole file (owner, 2026-09-30). Cards past it
// keep raw, id, outcome and resolution links; only fields become null. It bounds
// field-analysis CPU, not entry splitting or raw retention.
const MAX_FILE_ANALYSIS_LENGTH = 64 * 1_024;

/**
 * Backtick fence markers follow CommonMark info-string and closing-run rules.
 * Entry splitting uses strict indentation; field extraction accepts any
 * indentation so fences nested in lists still delimit proof blocks.
 */
const FENCE_OPEN = /^ {0,3}(`{3,})([^`]*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,})[ \t]*$/;
const FENCE_OPEN_ANY = /^[ \t]*(`{3,})([^`]*)$/;
const FENCE_CLOSE_ANY = /^[ \t]*(`{3,})[ \t]*$/;

function fenceMarker(line: string, openLength: number | null, anyIndent = false): number | null {
	const marker = openLength === null
		? line.match(anyIndent ? FENCE_OPEN_ANY : FENCE_OPEN)
		: line.match(anyIndent ? FENCE_CLOSE_ANY : FENCE_CLOSE);
	if (!marker || (openLength !== null && marker[1].length < openLength)) return null;
	return marker[1].length;
}

function clean(text: string): string {
	return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function sentence(text: string, max = 220): string {
	const value = text.replace(/`/g, "").trim();
	const first = value.match(/^.*?[.?!](?=\s|$)/)?.[0] ?? value;
	return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

function afterLabel(text: string, label: RegExp): string {
	return text.replace(label, "").replace(/^[:\s]+/, "").trim();
}

function shortCmd(text: string): string {
	let value = text.replace(/`/g, "").trim();
	value = value.replace(/^(?:[A-Z_][A-Z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)+/, "")
		.replace(/^\(?cd\s+\S+\s+&&\s+/, "").replace(/\)$/, "")
		.replace(/\s+2>&1.*$/, "").replace(/\s*\|.*$/, "")
		.replace(/^(?:bun|npm|pnpm|yarn)\s+(?:--\S+\s+)*run\s+/, "")
		.replace(/^(?:bun|npm|pnpm|yarn)\s+test\b/, "test")
		.replace(/(?:\/[\w.@-]+)+\/([^\s/]+)/g, "$1");
	return value.length > 48 ? `${value.slice(0, 47)}…` : value;
}

function safeAnalyse(raw: string): CardFields | null {
	try {
		return analyse(raw);
	} catch {
		// A failed heuristic must not hide the original entry.
		return null;
	}
}

function analyse(raw: string): CardFields | null {
	const bullets: string[] = [];
	const proofLines = new Set<string>();
	let fenceLength: number | null = null;
	for (const original of raw.slice(0, MAX_ENTRY_ANALYSIS_LENGTH).split("\n").slice(1)) {
		const marker = fenceMarker(original, fenceLength, true);
		if (marker !== null) {
			fenceLength = fenceLength === null ? marker : null;
			continue;
		}
		const line = clean(original.slice(0, MAX_ANALYSIS_LENGTH)).trim();
		if (/^(IDENTICAL|DIFFERENT|DIFF|CHANGED)\s+\S/.test(line)) proofLines.add(line);
		if (!line) continue;
		if (fenceLength !== null || /^[-*]\s+/.test(line) || !/^\s/.test(original) || !bullets.length) {
			bullets.push(line.replace(/^[-*]\s+/, ""));
		} else {
			const last = bullets.length - 1;
			bullets[last] = `${bullets[last]} ${line}`.slice(0, MAX_ANALYSIS_LENGTH);
		}
	}
	const assumed: string[] = [];
	const notRun: string[] = [];
	const evidence = new Set<string>();
	const checks = new Map<string, { cmd: string; exits: number[]; detail: string | null }>();
	const counts: { label: string; from: string; to: string }[] = [];
	const fields: { -readonly [K in keyof CardFields]: CardFields[K] } = {
		checks: [], counts, assumed, notRun, evidence: [],
	};
	let error: string | null = null;
	for (const b of bullets) {
		// Failed describes a failure; Checks records executions, not repeated descriptions.
		if (!/^failing(?: (?:command|check))?\b/i.test(b)) collectChecks(b, checks);
		if (/^selected\b/i.test(b) && !fields.why) fields.why = sentence(b);
		if (/^failing(?: (?:command|check))?\b/i.test(b)) {
			const cmd = b.match(/`([^`]+)`/)?.[1] ?? afterLabel(b, /^failing(?: (?:command|check))?/i).replace(/\s+exit.*$/i, "");
			const exit = b.match(/\bexit(?:ed|s)?(?: code)?[=\s]+(\d+)/i)?.[1];
			fields.failed = { cmd: shortCmd(cmd), exit: exit === undefined ? null : Number(exit), error: null };
		}
		const exact = b.match(/\bexact (?:error|diagnostic|blocker):?\s*(.+)/i);
		if (exact) error = sentence(exact[1], 160);
		if (/^diagnosis\b/i.test(b)) fields.cause = sentence(afterLabel(b, /^diagnosis/i));
		if (/^repair attempts?\b/i.test(b)) fields.tried = sentence(afterLabel(b, /^repair attempts?/i));
		const decision = b.match(/(?:question|decision) for parent:?\s*(.+)$/i) ?? b.match(/\b(parent must .+)$/i);
		if (decision && !fields.decide) fields.decide = sentence(decision[1], 300);
		if (/^(?:remaining steps (?:were )?not run|not run)\b/i.test(b)) {
			const list = sentence(afterLabel(b, /^(?:remaining steps (?:were )?not run|not run)/i)).replace(/\.$/, "");
			// A reason alone does not identify any unexecuted step.
			const steps = list.replace(/\bbecause\b.*$/i, "").trim();
			notRun.push(...steps.split(/,\s*|\s+and\s+/).map((s) => s.trim()).filter(Boolean));
		}
		for (const a of b.matchAll(/assumption:\s*([^.]*(?:\.|$))/gi)) if (a[1].trim()) assumed.push(sentence(a[1]));
		if (/before\/after|baseline\/current|->|→/.test(b)) {
			for (const m of b.matchAll(/([A-Za-z][\w-]{2,40})\s+(\d+)\s*(?:->|→)\s*(\d+)/g)) {
				if (!counts.some((x) => x.label === m[1])) counts.push({ label: m[1], from: m[2], to: m[3] });
			}
		}
		const stat = b.match(/\d+ files?, \d+ insertions? and \d+ deletions?/);
		if (stat) fields.diff = stat[0];
		// Tokenize once, then anchor suffix checks to avoid retrying at every word boundary.
		for (const token of b.matchAll(/[\w.@/-]+/g)) {
			const value = token[0].replace(/\.+$/, "");
			const suffix = value.includes("/") ? /\.(?:log|txt|diff|status|json|md)$/ : /\.(?:log|diff|status)$/;
			if (suffix.test(value)) evidence.add(value);
		}
	}
	if (fields.failed && error) fields.failed = { ...fields.failed, error };
	if (proofLines.size) fields.proof = { identical: [...proofLines].filter((s) => /^IDENTICAL\s/.test(s)).length, total: proofLines.size };
	fields.evidence = [...evidence];
	fields.checks = [...checks.values()];
	const recognized = fields.failed || fields.cause || fields.tried || fields.decide || fields.proof || fields.diff || fields.why || counts.length || assumed.length || notRun.length || evidence.size || checks.size;
	return recognized ? fields : null;
}

function collectChecks(text: string, checks: Map<string, { cmd: string; exits: number[]; detail: string | null }>): void {
	const hits: { cmd: string; at: number; exit: number; detail: string | null }[] = [];
	const patterns = [
		/`([^`]{2,200})`\s*(?:,\s*)?(?:exit(?:ed|s)?(?: code)?)[=\s]+(\d+)/gi,
		/((?:bun|npm|pnpm|yarn)\s+(?:run\s+)?[\w:.-]+(?:\s+--\s+[\w/.-]+)?)\s+exit(?:ed|s)?(?: code)?[=\s]+(\d+)/gi,
		/(?<![\w:.-])([\w:.-]+)[ \t]+exit=(\d+)/g,
	];
	const detailAfter = (end: number): string | null => {
		const detail = text.slice(end).match(/^\s*[:,]?\s*([^.;]{3,80})/)?.[1]?.trim();
		return detail && /\d/.test(detail) && !/^(under|with|and|from|on|seconds=|command=)\b/.test(detail)
			? detail.replace(/`/g, "").replace(/^\(+|\)+$/g, "") : null;
	};
	for (const pattern of patterns) {
		for (const m of text.matchAll(pattern)) {
			const cmd = shortCmd(m[1]);
			// Output capture and git metadata commands are evidence plumbing, not verification gates.
			if (!cmd || /^-/.test(cmd) || /^[0-9a-f]{7,40}$/.test(cmd) || /^(printf|tail|git merge-base|git diff --stat)\b/.test(cmd)) continue;
			const end = m.index + m[0].length;
			if (!hits.some((h) => h.at === end)) {
				hits.push({ cmd, at: end, exit: Number(m[2]), detail: detailAfter(end) });
			}
		}
	}
	for (const m of text.matchAll(/\bre-?r(?:an|un)\b[^.;]{0,20}?\bexit(?:ed|s)?(?: code)?[=\s]+(\d+)/gi)) {
		const previous = hits.filter((h) => h.at < m.index).sort((a, b) => b.at - a.at)[0];
		if (previous) hits.push({ cmd: previous.cmd, at: m.index + m[0].length, exit: Number(m[1]), detail: detailAfter(m.index + m[0].length) });
	}
	hits.sort((a, b) => a.at - b.at);
	for (const hit of hits) {
		const check = checks.get(hit.cmd) ?? { cmd: hit.cmd, exits: [], detail: null };
		check.exits.push(hit.exit);
		if (hit.detail !== null) check.detail = hit.detail;
		checks.set(hit.cmd, check);
	}
}
