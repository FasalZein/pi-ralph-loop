import type { LoopSnapshot } from "../types.js";
import { rawRows } from "./detail.js";
import { clean, style } from "./layout.js";
import { attemptCard, spread } from "./overview.js";

/** Progress title: passed and blocked entry counts flush right (design spec section 5). */
export function progressTitle(snapshot: LoopSnapshot | null, width: number): string {
	const cards = snapshot?.attempts ?? [];
	const passed = cards.filter((c) => c.outcome === "passed").length;
	const blocked = cards.filter((c) => c.outcome === "blocked").length;
	return spread(style.bold("Progress"), cards.length ? `${passed} passed · ${blocked} blocked` : "", width);
}

/**
 * Every progress entry as a card, newest first, with its item id before the card (spec #1 story 43).
 * `raw` shows each sanitized raw entry instead (story 44). A card past the analysis budget shows its heading only.
 */
export function progressBody(snapshot: LoopSnapshot | null, width: number, raw: boolean): string[] {
	const rows: string[] = [];
	for (const card of [...(snapshot?.attempts ?? [])].reverse()) {
		if (rows.length) rows.push("");
		if (raw) { rows.push(...rawRows(card, width)); continue; }
		const id = card.id === null ? "" : `${style.bold(clean(card.id))} `;
		const [head, ...rest] = attemptCard(card, Math.max(0, width - (card.id === null ? 0 : clean(card.id).length + 1)));
		rows.push(`${id}${head ?? ""}`, ...rest);
	}
	return rows;
}
