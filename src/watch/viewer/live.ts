import type { EventFrame, ToolEntry } from "../types.js";
import { clean } from "./layout.js";

// Authority: approved viewer design, spec #1: 200-entry in-memory ring.
export const FEED_ENTRIES = 200;
export const FILTERS = ["all", "tools", "messages", "errors"] as const;
export type FeedFilter = typeof FILTERS[number];
type FeedEntry =
	| { readonly kind: "tool"; readonly tool: ToolEntry }
	| { readonly kind: "message"; readonly text: string }
	| { readonly kind: "error" | "boundary"; readonly text: string };
export type LiveFeed = {
	readonly connected: boolean;
	readonly lastPiAt: string | null;
	readonly identity: string | null;
	readonly lastSeq: number | null;
	readonly iteration: number | null;
	readonly entries: readonly FeedEntry[];
	readonly unavailable: string | null;
};
export const emptyFeed = (): LiveFeed => ({ connected: false, lastPiAt: null, identity: null, lastSeq: null, iteration: null, entries: [], unavailable: "activity unavailable" });
const append = (feed: LiveFeed, entry: FeedEntry): LiveFeed => ({ ...feed, entries: [...feed.entries, entry].slice(-FEED_ENTRIES) });
function upsert(feed: LiveFeed, tool: ToolEntry): LiveFeed {
	const boundary = feed.entries.reduce((last, e, index) => e.kind === "boundary" ? index : last, -1);
	const i = feed.entries.findIndex((e, index) => index > boundary && e.kind === "tool" && e.tool.id === tool.id);
	return i < 0 ? append(feed, { kind: "tool", tool }) : { ...feed, entries: feed.entries.map((e, n) => n === i ? { kind: "tool", tool } : e) };
}
export function disconnect(feed: LiveFeed, reason: string): LiveFeed {
	return { ...feed, connected: false, unavailable: `activity unavailable: ${reason}` };
}
export function applyFrame(previous: LiveFeed, frame: EventFrame): LiveFeed {
	let feed = previous;
	if (frame.type === "hello") {
		const identity = JSON.stringify([frame.launchId, frame.loop?.token, frame.loop?.startedAt]);
		if (identity !== feed.identity) feed = emptyFeed();
		if (feed.lastSeq !== null && frame.nextSeq !== feed.lastSeq + 1) feed = append(feed, { kind: "error", text: "activity gap: stream records lost" });
		if (feed.iteration !== null && feed.iteration !== frame.loop?.iteration) feed = append(feed, { kind: "boundary", text: `iteration ${frame.loop?.iteration ?? "unknown"}` });
		feed = { ...feed, iteration: frame.loop?.iteration ?? null, connected: true, unavailable: null, lastPiAt: frame.lastPiAt, identity, lastSeq: frame.nextSeq - 1 };
		for (const tool of frame.tools) feed = upsert(feed, tool);
		return feed;
	}
	if (feed.lastSeq !== null && frame.seq !== feed.lastSeq + 1) feed = append(feed, { kind: "error", text: "activity gap: stream records lost" });
	feed = { ...feed, lastSeq: frame.seq };
	if (frame.type === "gap") return append(feed, { kind: "error", text: `activity gap: ${frame.source} ${frame.from}–${frame.to}` });
	if (frame.type === "lifecycle") {
		if (frame.state === "launch-failed" || frame.state === "pi-exited") return append(feed, { kind: "error", text: `${frame.state}${frame.detail ? `: ${frame.detail}` : ""}` });
		return feed;
	}
	if (frame.type !== "event") return feed;
	const e = frame.event;
	// Only receive times of pi records prove activity. Facts and lifecycle are independent channels.
	if (e.kind !== "fact") feed = { ...feed, lastPiAt: frame.at };
	switch (e.kind) {
		case "tool-start": case "tool-end": return upsert(feed, e.tool);
		case "message": return append(feed, { kind: "message", text: e.text });
		case "refusal": return append(feed, { kind: "error", text: `${e.tool}: ${e.text}` });
		case "dialog-cancelled": return append(feed, { kind: "error", text: `dialog cancelled: ${e.method}${e.title ? ` ${e.title}` : ""}` });
		case "fact": {
			if (e.fact.iteration !== feed.iteration || e.fact.kind === "iteration-start") feed = append(feed, { kind: "boundary", text: `iteration ${e.fact.iteration}` });
			return { ...feed, iteration: e.fact.iteration };
		}
		case "assistant-end": return e.stopReason === "error" ? append(feed, { kind: "error", text: "agent error" }) : feed;
		case "activity": return feed;
	}
}
export function visibleEntries(feed: LiveFeed, filter: FeedFilter): readonly FeedEntry[] {
	return feed.entries.filter((e) => filter === "all" || (filter === "tools" && e.kind === "tool") || (filter === "messages" && e.kind === "message") || (filter === "errors" && (e.kind === "error" || (e.kind === "tool" && e.tool.endedAt !== null && e.tool.error))));
}
const verbs = new Map([["read", "Read"], ["grep", "Search"], ["find", "Search"], ["ls", "Search"], ["edit", "Edit"], ["write", "Edit"], ["bash", "Execute"]]);
export function feedRows(feed: LiveFeed, filter: FeedFilter): string[] {
	const rows = visibleEntries(feed, filter).map((e) => {
		switch (e.kind) {
			case "tool": {
				const t = e.tool;
				const end = t.endedAt !== null ? `${t.error ? " ✕" : ""} ${t.ms === null ? "duration unknown" : `${t.ms}ms`}` : "";
				return clean(`${verbs.get(t.name) ?? t.name} ${t.label}${end}`);
			}
			case "message": return `◆ ${clean(e.text)}`;
			case "error": return `⚠ ${clean(e.text)}`;
			case "boundary": return clean(e.text);
		}
	});
	if (feed.unavailable) rows.push(clean(feed.unavailable));
	return rows;
}
