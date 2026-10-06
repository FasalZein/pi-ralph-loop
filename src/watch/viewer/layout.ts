import { type Component, Container, type StackEntry, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// pi-tui marks layout containers with this registered symbol (dist/layout-node.js in 0.84.4 and 0.99.2).
// The package index does not export it, so this is a private contract. Keep every use in this module.
// Revisit when pi-tui exports the symbol or a dynamic stack (ask upstream).
const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");

/** One stack child with an exact size in rows (vstack) or columns (hstack). */
export type Region = { readonly component: Component; readonly size: number };

/**
 * A stack whose regions are recomputed on every layout pass. Sizes are exact bases with no `grow`,
 * because the pi-tui `grow` split skews weights (design spec section 8).
 */
export class Stack extends Container {
	constructor(private readonly kind: "vstack" | "hstack", private readonly regions: () => readonly Region[]) {
		super();
	}

	[LAYOUT_NODE]() {
		const entries: StackEntry[] = this.regions().map((region) => ({ component: region.component, basis: region.size, shrink: 0 }));
		return { type: this.kind, entries, gap: 0, align: "stretch" as const };
	}

	/** TuiAltScreen prints the root's unbounded render on stop (design spec section 8). Print nothing. */
	override render(): string[] {
		return [];
	}
}

/**
 * Give each size in order until `total` runs out; the single "rest" entry takes what fixed sizes leave.
 * The result always sums to `total`. A small terminal truncates from the bottom (owner, 2026-10-01: no minimum size).
 */
export function allocate(total: number, sizes: readonly (number | "rest")[]): number[] {
	const fixed = sizes.reduce<number>((n, s) => n + (s === "rest" ? 0 : s), 0);
	let left = Math.max(0, total);
	return sizes.map((s) => {
		const want = s === "rest" ? Math.max(0, total - fixed) : s;
		const got = Math.min(want, left);
		left -= got;
		return got;
	});
}

/** Remove terminal sequences and control characters from untrusted text before drawing (spec #1 behaviour). */
export function clean(text: string): string {
	// eslint-disable-next-line no-control-regex
	return stripTerminalSequences(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

/** Truncate or pad a styled line to exactly `width` columns. */
export function fit(line: string, width: number): string {
	if (width <= 0) return "";
	const cut = visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line;
	return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

const sgr = (code: string) => (text: string) => `\x1b[${code}m${text}\x1b[0m`;
export const style = {
	// Accent orange, truecolor 236,124,64 (design spec section 1). Status colours come from the terminal theme.
	accent: sgr("38;2;236;124;64"),
	bold: sgr("1"),
	dim: sgr("2"),
	red: sgr("31"),
	green: sgr("32"),
	yellow: sgr("33"),
} as const;

/**
 * A leaf that renders one line per row. A render failure shows inline in this leaf and never
 * reaches the render loop (spec #1: panel errors show inline).
 */
export class Lines implements Component {
	constructor(private readonly draw: (width: number) => readonly string[], private readonly label = "panel") {}

	render(width: number): string[] {
		try {
			return this.draw(width).map((line) => fit(line, width));
		} catch (error) {
			return [fit(style.red(`✕ ${this.label} failed: ${clean(message(error))}`), width)];
		}
	}

	invalidate(): void {}
}

/** A titled region. The frame draws the borders it shares with its neighbours (design spec: Look A). */
export class Panel implements Component {
	constructor(private readonly title: (width: number) => string, private readonly body: (width: number) => readonly string[], private readonly name: string) {}

	render(width: number): string[] {
		const inner = Math.max(0, width - 2);
		const pad = (line: string) => fit(` ${fit(line, inner)} `, width);
		let title: string;
		try {
			title = this.title(inner);
		} catch {
			title = style.bold(this.name);
		}
		try {
			return [pad(title), ...this.body(inner).map(pad)];
		} catch (error) {
			return [pad(title), pad(style.red(`✕ ${this.name} failed: ${clean(message(error))}`))];
		}
	}

	invalidate(): void {}
}

export const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
