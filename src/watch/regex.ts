import { setFlagsFromString } from "node:v8";

// Owner decision on #12 (2026-10-06): opt into V8's experimental linear
// engine in each process that loads watch policy (including the pi host).
// Only explicit `l` regexes use it; package-owned regexes are unchanged.
let enabled = false;
const compiled = new Map<string, RegExp>();
export function linearRegex(source: string): RegExp {
	if (!enabled) {
		setFlagsFromString("--enable-experimental-regexp-engine");
		// Fail closed if this runtime cannot enable the engine.
		new RegExp("", "l");
		enabled = true;
	}
	let expression = compiled.get(source);
	if (!expression) {
		expression = new RegExp(source, "l");
		compiled.set(source, expression);
	}
	return expression;
}
