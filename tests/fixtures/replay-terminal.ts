import type { Terminal } from "@earendil-works/pi-tui";

/**
 * A scripted terminal for viewer tests. It records every write and keeps a plain-text cell model of
 * the screen: cursor position (CSI row;col H), erase line (CSI 2K), erase screen (CSI 2J) and
 * printable text. Styling (SGR) and other sequences are dropped. One code point is one cell; the
 * viewer draws box-drawing glyphs, which are one column wide.
 */
export class ReplayTerminal implements Terminal {
	readonly writes: string[] = [];
	/** Writes made after `stop()`, i.e. what would land on the main screen buffer. */
	readonly afterStop: string[] = [];
	started = false;
	stopped = false;
	private onInput: ((data: string) => void) | null = null;
	private onResize: (() => void) | null = null;
	private grid: string[][] = [];
	private row = 0;
	private col = 0;

	constructor(private cols: number, private height: number) {
		this.clear();
	}

	get columns(): number { return this.cols; }
	get rows(): number { return this.height; }
	get kittyProtocolActive(): boolean { return false; }

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.started = true;
		this.onInput = onInput;
		this.onResize = onResize;
	}

	stop(): void { this.stopped = true; }
	async drainInput(): Promise<void> {}

	write(data: string): void {
		(this.stopped ? this.afterStop : this.writes).push(data);
		if (!this.stopped) this.apply(data);
	}

	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void { this.clear(); }
	setTitle(): void {}
	setProgress(): void {}

	/** Deliver one input sequence, as the stdin buffer would. */
	send(data: string): void {
		if (!this.onInput) throw new Error("terminal not started");
		this.onInput(data);
	}

	resize(cols: number, rows: number): void {
		this.cols = cols;
		this.height = rows;
		this.clear();
		this.onResize?.();
	}

	/** The visible screen, one string per row, trailing spaces kept. */
	screen(): string[] {
		return this.grid.map((cells) => cells.join(""));
	}

	text(): string {
		return this.screen().join("\n");
	}

	private clear(): void {
		this.grid = Array.from({ length: this.height }, () => Array.from({ length: this.cols }, () => " "));
	}

	private apply(data: string): void {
		let i = 0;
		while (i < data.length) {
			const ch = data[i];
			if (ch === "\x1b") {
				const csi = /^\x1b\[([?<>=]?)([0-9;:]*)([ -/]*)([@-~])/.exec(data.slice(i));
				if (csi) {
					const [all, prefix, params, , final] = csi;
					if (!prefix && final === "H") {
						const [r, c] = params.split(";").map((n) => Number(n || "1"));
						this.row = (r ?? 1) - 1;
						this.col = (c ?? 1) - 1;
					} else if (!prefix && final === "K" && params === "2") {
						if (this.grid[this.row]) this.grid[this.row] = Array.from({ length: this.cols }, () => " ");
					} else if (!prefix && final === "J" && params === "2") this.clear();
					i += all.length;
					continue;
				}
				// OSC and other string sequences end with BEL or ST.
				const osc = /^\x1b[\]P_^][\s\S]*?(\x07|\x1b\\)/.exec(data.slice(i));
				i += osc ? osc[0].length : 2;
				continue;
			}
			if (ch === "\r") { this.col = 0; i++; continue; }
			if (ch === "\n") { this.row++; i++; continue; }
			const cp = data.codePointAt(i)!;
			const glyph = String.fromCodePoint(cp);
			if (this.grid[this.row] && this.col < this.cols) this.grid[this.row][this.col] = glyph;
			this.col++;
			i += glyph.length;
		}
	}
}
