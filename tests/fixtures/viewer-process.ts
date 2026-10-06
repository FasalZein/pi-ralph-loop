import { runViewer } from "../../src/watch/viewer.ts";
import { openLoop } from "../../src/watch/loop-state.ts";
import { ReplayTerminal } from "./replay-terminal.ts";

const terminal = new ReplayTerminal(120, 30);
const screen = setInterval(() => process.send?.(terminal.text()), 20);
try {
	await runViewer({ roots: [process.argv[2]] }, {
		terminal, openLoop, now: Date.now,
		setInterval: (fn, ms) => setInterval(fn, ms),
		clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
	});
} finally { clearInterval(screen); }
