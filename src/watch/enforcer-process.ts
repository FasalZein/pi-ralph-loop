import { STOP_ACK_TIMEOUT_MS } from "./commands.js";
import { probeRunner } from "./probe-runner.js";
import { loadMission } from "./config.js";
import { evaluate } from "./enforcer.js";
import { appendAlerts, alertIdentity, readAlerts, readEnforcerStatus, writeEnforcerStatus, findingIdentity, type EnforcerStatus, type StopRecord } from "./alert-log.js";
import { deriveLiveness } from "./health.js";
import { connectEvents, isTerminal, controlLoop } from "./driver.js";
import { isAlive, readMetadata } from "./transport.js";
import { openLoop, type ObservationRuntime } from "./loop-state.js";
import type { Alert, LaunchBaseline, Mission, Receipt, RunKey } from "./types.js";

// Authority: spec #1 thresholds, min(60 s / 6, 1,800 s / 180).
export const ENFORCER_POLL_MS = 10_000;
export type EnforcerSpec = LaunchBaseline & { readonly root: string; readonly mission: Mission; readonly run: RunKey & { readonly launchId: string } };
export type EnforcementRuntime = {
	readonly events?: typeof connectEvents;
	readonly signal?: AbortSignal; readonly observation?: ObservationRuntime;
	readonly stop?: (run: RunKey, signal: AbortSignal) => Promise<Receipt>;
	readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	readonly append?: typeof appendAlerts; readonly writeStatus?: typeof writeEnforcerStatus;
	readonly log?: (message: string) => void;
};
export type EnforcerExit = { readonly reason: "aborted" | "stopped" };
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
	if (signal?.aborted) { resolve(); return; }
	const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
	const timer = setTimeout(done, ms); signal?.addEventListener("abort", done, { once: true });
});

/** Independent observer. Durable evidence and intent are prerequisites for every stop dispatch. */
export async function runEnforcer(spec: EnforcerSpec, runtime: EnforcementRuntime = {}): Promise<EnforcerExit> {
	const probes = probeRunner(spec.root, spec.mission, runtime);
	const reader = openLoop(spec.root, { mission: spec.mission, runtime: runtime.observation });
	const append = runtime.append ?? appendAlerts; const write = runtime.writeStatus ?? writeEnforcerStatus;
	const log = runtime.log ?? console.error;
	let records: readonly Alert[] = []; let loaded = false; let stop: StopRecord | null = null;
	let last: EnforcerStatus | null = null;
	const eventAbort = new AbortController();
	const eventSignal = runtime.signal ? AbortSignal.any([runtime.signal, eventAbort.signal]) : eventAbort.signal;
	let live: { connected: boolean; lastPiAt: string | null } = { connected: false, lastPiAt: null };
	let loop = spec.run.loopToken && spec.run.startedAt ? { token: spec.run.loopToken, startedAt: spec.run.startedAt } : null;
	let driverEnd: "not-launched" | "driver-closed" | null = null;
	let piExited = false;
	let driverPid: number | null = null;
	let streamFailed = false;
	try {
		const metadata = readMetadata(spec.root, { allowDead: true });
		if (metadata.launchId === spec.run.launchId) driverPid = metadata.pid;
	} catch { /* Without a validated launch identity, socket loss proves no driver death. */ }
	const events = (async () => {
		try {
			for await (const frame of (runtime.events ?? connectEvents)({ root: spec.root, run: spec.run }, eventSignal)) {
				if (frame.type === "hello") { if (frame.launchId === spec.run.launchId) driverPid = frame.pid; live = { connected: true, lastPiAt: frame.lastPiAt }; loop = frame.loop ?? loop; }
				else if (frame.type === "event") {
					live.lastPiAt = frame.at;
					if (frame.event.kind === "fact" && (frame.event.fact.kind === "iteration-start")) {
						const fact = frame.event.fact;
						loop = { token: fact.run.loopToken, startedAt: fact.run.startedAt };
					}
				} else if (frame.type === "lifecycle") {
					if (frame.state === "pi-exited") piExited = true;
					if (frame.state === "closed") driverEnd = loop ? "driver-closed" : "not-launched";
				}
			}
		} catch (error) {
			if (!eventSignal.aborted) {
				streamFailed = true;
				log(`ralph enforcer: activity unavailable: ${message(error)}`);
				// Capture the PID only from this launch's validated metadata/hello.
				// A different launch must never supply the PID for a death check.
				if (driverPid !== null && !isAlive(driverPid)) driverEnd = "driver-closed";
			}
		}
		finally { if (piExited && !eventSignal.aborted) driverEnd ??= loop ? "driver-closed" : "not-launched"; live.connected = false; }
	})();
	try {
		while (!runtime.signal?.aborted) {
			const snapshot = await reader.read(runtime.signal);
			// A disconnect can precede OS reaping of a killed driver. Recheck on
			// later polls rather than treating that transient PID liveness as permanent.
			if (streamFailed && driverPid !== null && !isAlive(driverPid)) driverEnd = "driver-closed";
			const run = { ...snapshot.run, launchId: spec.run.launchId };
			const emit = (rule: string, level: Alert["level"], evidence: readonly string[]): Alert => ({ timestamp: snapshot.observedAt, level, rule, evidence, item: null, commit: null, run });
			try {
				if (!loaded) {
					records = await readAlerts(spec.root);
					const prior = await readEnforcerStatus(spec.root);
					stop = prior?.run.launchId === spec.run.launchId ? prior.stop : null;
					loaded = true;
				}
				const alerts: Alert[] = [...evaluate(snapshot, spec.mission, spec, probes.read(snapshot.gitVersion)).map(a => ({ ...a, run }))];
				try {
					const current = await loadMission(spec.root);
					if (current.configHash !== spec.mission.configHash) alerts.push(emit("config-changed", "HARD", [`pinned config ${spec.mission.configHash}`, `validated config ${current.configHash}`]));
				} catch (error) { alerts.push(emit("config-reload-unavailable", "WARN", [message(error)])); }
				const liveness = deriveLiveness(snapshot, loop && snapshot.run.loopToken === loop.token && snapshot.run.startedAt === loop.startedAt ? live : null, runtime.observation?.now() ?? new Date());
				const livenessAlert = (rule: string, evidence: readonly string[]) => { if (spec.mission.rules[rule] !== "off") alerts.push(emit(rule, "WARN", evidence)); };
				if (snapshot.health.stale) livenessAlert("heartbeat-stale", ["owner heartbeat older than 60 s"]);
				if (liveness.stalled === true) livenessAlert("rpc-stall", ["no pi event received for 30 min"]);
				if (snapshot.health.counters?.errors.rising) livenessAlert("error_count-rise", [`errors ${snapshot.health.counters.errors.previous} -> ${snapshot.health.counters.errors.value}`]);
				if (snapshot.health.counters?.bundleRejections.rising) livenessAlert("bundle_rejection_count-rise", [`bundle rejections ${snapshot.health.counters.bundleRejections.previous} -> ${snapshot.health.counters.bundleRejections.value}`]);
				const torn = snapshot.issues.some(i => i.kind === "concurrent");
				if (!torn && !alerts.some(a => ["coverage-incomplete", "measure-unavailable", "importer-check-unavailable", "config-reload-unavailable"].includes(a.rule)) && snapshot.git && snapshot.evidence?.index.status === "fresh" && snapshot.evidence.worktree.status === "fresh") {
					const raised = new Set(alerts.filter(a => a.level === "HARD").map(findingIdentity));
					const resolved = new Set(records.filter(a => a.rule === "hard-resolved").flatMap(a => a.evidence));
					for (const prior of records.filter(a => a.level === "HARD" && a.run.launchId !== run.launchId)) {
						const id = alertIdentity(prior);
						// Historical findings cannot be resolved without complete history coverage.
						if (!raised.has(findingIdentity(prior)) && !resolved.has(id) && (prior.commit === null || snapshot.git.commits && snapshot.sources.history.status === "fresh")) {
							alerts.push(emit("hard-resolved", "INFO", [id])); resolved.add(id);
						}
					}
				}
				const terminal = !!loop && isTerminal(snapshot, loop);
				const ended = driverEnd !== null || terminal;
				if (ended && !records.some(a => a.run.launchId === run.launchId && a.rule === "loop-ended")) alerts.push(emit("loop-ended", "INFO", [`reason: ${terminal ? snapshot.state?.stop_reason ?? "unknown" : driverEnd ?? "unknown"}`, `stop: ${JSON.stringify(stop)}`, `findings: ${JSON.stringify(records.filter(a => a.run.launchId === run.launchId).reduce((counts, a) => ({ ...counts, [a.level]: counts[a.level] + 1 }), { HARD: 0, WARN: 0, INFO: 0 }))}`]));
				const known = new Set(records.map(alertIdentity));
				const added = alerts.filter(a => { const id = alertIdentity(a); if (known.has(id)) return false; known.add(id); return true; });
				await append(spec.root, added); records = [...records, ...added];
				const own = records.filter(a => a.run.launchId === spec.run.launchId);
				const counts = { HARD: 0, WARN: 0, INFO: 0 }; for (const a of own) counts[a.level]++;
				const hard = alerts.some(a => a.level === "HARD");
				last = { v: 1, pid: process.pid, run, configHash: spec.mission.configHash, state: ended ? "stopped" : hard || stop ? "stopping" : torn || !snapshot.git || !snapshot.evidence || snapshot.evidence.index.status !== "fresh" || snapshot.evidence.worktree.status !== "fresh" || snapshot.evidence.baseAncestor === null || snapshot.sources.history.status !== "fresh" ? "unavailable" : "ready", polledAt: snapshot.observedAt, commitsChecked: snapshot.git?.commits?.length ?? 0, counts, stop };
				if (!ended && !driverEnd && hard && !(stop && (stop.phase === "accepted" || stop.phase === "completed"))) {
					stop = { phase: "intent" }; last = { ...last, stop };
					await write(spec.root, last);
					// A close received during persistence ends the launch without dispatch.
					if (driverEnd) continue;
					try {
						// Authority: owner #10, stop acknowledgement deadline 15 s.
						const timeout = AbortSignal.timeout(STOP_ACK_TIMEOUT_MS);
						const signal = runtime.signal ? AbortSignal.any([runtime.signal, timeout]) : timeout;
						stop = await (runtime.stop ?? ((run, signal) => controlLoop({ root: spec.root, run }, { kind: "stop" }, signal)))(run, signal);
						const result = emit("stop-command-result", "INFO", [`${stop.phase}${stop.reason ? `: ${stop.reason}` : ""}`]);
						if (!records.some(a => alertIdentity(a) === alertIdentity(result))) { await append(spec.root, [result]); records = [...records, result]; }
					} catch (error) {
						log(`ralph enforcer: stop failed; retry next poll: ${message(error)}`);
						const result = emit("stop-command-result", "INFO", [message(error)]);
						if (!records.some(a => alertIdentity(a) === alertIdentity(result))) { await append(spec.root, [result]); records = [...records, result]; }
					}
				}
				const finalCounts = { HARD: 0, WARN: 0, INFO: 0 };
				for (const a of records) if (a.run.launchId === spec.run.launchId) finalCounts[a.level]++;
				last = { ...last, stop, counts: finalCounts };
				await write(spec.root, last);
				if (ended) return { reason: "stopped" };
			} catch (error) {
				loaded = false;
				log(`ralph enforcer: UNAVAILABLE; no stop dispatched without persisted evidence: ${message(error)}`);
				await write(spec.root, { v: 1, pid: process.pid, run, configHash: spec.mission.configHash, polledAt: snapshot.observedAt, commitsChecked: 0, counts: { HARD: 0, WARN: 0, INFO: 0 }, ...last, state: "unavailable", stop }).catch(error => log(`ralph enforcer: status unavailable: ${message(error)}`));
			}
			await (runtime.sleep ?? sleep)(ENFORCER_POLL_MS, runtime.signal);
		}
		return { reason: "aborted" };
	} finally {
		eventAbort.abort(); await events; await probes.close(); await reader.close();
		if (last && last.state !== "stopped") await write(spec.root, { ...last, state: "down", stop }).catch(error => log(`ralph enforcer: final status unavailable: ${message(error)}`));
	}
}
