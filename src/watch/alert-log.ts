import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { object } from "./journal.js";
import type { Alert, Receipt, RunKey } from "./types.js";

export const ALERT_LOG = ".ralph/enforcer-alerts.jsonl";
export const ENFORCER_STATUS = ".ralph/enforcer.json";
export type StopRecord = { readonly phase: "intent" } | Receipt;
export type EnforcerStatus = {
	readonly v: 1; readonly pid: number; readonly run: RunKey; readonly configHash: string;
	readonly state: "ready" | "unavailable" | "stopping" | "stopped" | "down";
	readonly polledAt: string; readonly commitsChecked: number;
	readonly counts: { readonly HARD: number; readonly WARN: number; readonly INFO: number };
	readonly stop: StopRecord | null;
};
export type EnforcerView = { readonly alerts: readonly Alert[]; readonly status: EnforcerStatus; readonly commitsChecked: number };
const nullableString = (v: unknown) => v === null || typeof v === "string";
function runKey(v: unknown): v is RunKey { return object(v) && nullableString(v.launchId) && nullableString(v.loopToken) && nullableString(v.startedAt); }
function alert(v: unknown): v is Alert {
	return object(v) && typeof v.timestamp === "string" && ["HARD", "WARN", "INFO"].includes(String(v.level)) && typeof v.rule === "string" && nullableString(v.item) && nullableString(v.commit) && Array.isArray(v.evidence) && v.evidence.every(s => typeof s === "string") && runKey(v.run);
}
function status(v: unknown): v is EnforcerStatus {
	return object(v) && v.v === 1 && Number.isSafeInteger(v.pid) && Number(v.pid) > 0 && runKey(v.run) && typeof v.configHash === "string" && ["ready", "unavailable", "stopping", "stopped", "down"].includes(String(v.state)) && typeof v.polledAt === "string" && Number.isSafeInteger(v.commitsChecked) && Number(v.commitsChecked) >= 0 && object(v.counts) && [v.counts.HARD, v.counts.WARN, v.counts.INFO].every(n => Number.isSafeInteger(n) && Number(n) >= 0) && (v.stop === null || object(v.stop) && (v.stop.phase === "intent" || ["sent", "accepted", "completed"].includes(String(v.stop.phase)) && typeof v.stop.id === "string" && runKey(v.stop.run)));
}
async function read(root: string, file: string): Promise<string | null> {
	let fd;
	try { fd = await open(join(root, file), constants.O_RDONLY | constants.O_NOFOLLOW); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
	try { if (!(await fd.stat()).isFile()) throw new Error(`${file} is not a regular file`); return await fd.readFile("utf8"); }
	finally { await fd.close(); }
}
export function findingIdentity(a: Alert): string { return JSON.stringify([a.rule, a.level, a.item, a.commit, a.evidence]); }
export function alertIdentity(a: Alert): string { return JSON.stringify([a.run.launchId, findingIdentity(a)]); }
export async function readAlerts(root: string): Promise<readonly Alert[]> {
	const text = await read(root, ALERT_LOG); if (text === null) return [];
	const lines = text.split("\n");
	// Never append past a torn line: a crash must not hide durable HARD evidence.
	if (lines.pop() !== "") throw new Error("Alert log has an incomplete final line");
	return lines.filter(Boolean).map(line => { const value: unknown = JSON.parse(line); if (!alert(value)) throw new Error("Malformed alert record"); return value; });
}
export async function readEnforcerStatus(root: string): Promise<EnforcerStatus | null> {
	const text = await read(root, ENFORCER_STATUS); if (text === null) return null;
	const value: unknown = JSON.parse(text); if (!status(value)) throw new Error("Malformed enforcer status"); return value;
}
export async function appendAlerts(root: string, alerts: readonly Alert[]): Promise<void> {
	if (!alerts.length) return;
	const fd = await open(join(root, ALERT_LOG), constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
	try {
		const stat = await fd.stat();
		if (!stat.isFile()) throw new Error("Alert log is not a regular file");
		if (stat.size) {
			const last = Buffer.alloc(1); const { bytesRead } = await fd.read(last, 0, 1, stat.size - 1);
			if (bytesRead !== 1 || last[0] !== 10) throw new Error("Alert log has an incomplete final line");
		}
		await fd.writeFile(alerts.map(a => `${JSON.stringify(a)}\n`).join(""));
		await fd.sync();
	}
	finally { await fd.close(); }
}
export async function writeEnforcerStatus(root: string, value: EnforcerStatus): Promise<void> {
	const target = join(root, ENFORCER_STATUS);
	const temporary = `${target}.${process.pid}.tmp`;
	let created = false;
	try {
		const fd = await open(temporary, "wx", 0o600);
		created = true;
		try { await fd.writeFile(JSON.stringify(value)); await fd.sync(); }
		finally { await fd.close(); }
		await rename(temporary, target);
		const dir = await open(join(root, ".ralph"), "r");
		try { await dir.sync(); } finally { await dir.close(); }
	} finally {
		if (created) await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
	}
}
/** Runtime files never count as author edits or invalidate a git content stamp. */
export function enforcerRuntimePath(file: string): boolean { return file === ALERT_LOG || file === ENFORCER_STATUS || /^\.ralph\/enforcer\.json\.\d+\.tmp$/.test(file); }
