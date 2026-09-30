import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	FACT_SOCKET_ENV,
	isLoopFactChannelConfigured,
	LAUNCH_ID_ENV,
	type LoopFactEnvelope,
	publishLoopFact,
} from "../src/loop/watch-events.ts";
import type { RalphLoopState } from "../src/types.ts";

type Receiver = {
	path: string;
	frames: LoopFactEnvelope[];
	connections: Socket[];
	server: Server;
	close: () => Promise<void>;
};

function shortSocketPath(): string {
	// macOS limits Unix socket paths to 104 bytes; keep the name short.
	return join(tmpdir(), `rw-${randomUUID().slice(0, 8)}.sock`);
}

async function startReceiver(path = shortSocketPath()): Promise<Receiver> {
	const frames: LoopFactEnvelope[] = [];
	const connections: Socket[] = [];
	const server = createServer((socket) => {
		connections.push(socket);
		let buffered = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffered += chunk;
			let newline = buffered.indexOf("\n");
			while (newline >= 0) {
				frames.push(JSON.parse(buffered.slice(0, newline)));
				buffered = buffered.slice(newline + 1);
				newline = buffered.indexOf("\n");
			}
		});
		socket.on("error", () => {});
	});
	await new Promise<void>((resolve) => server.listen(path, resolve));
	return {
		path,
		frames,
		connections,
		server,
		close: async () => {
			for (const socket of connections) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(path, { force: true });
		},
	};
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function makeState(overrides: Partial<RalphLoopState> = {}): RalphLoopState {
	return {
		running: true,
		iteration: 1,
		max_iterations: 3,
		started_at: "2026-09-30T00:00:00.000Z",
		completed_at: null,
		stop_reason: null,
		session_id: "session-1",
		last_session_file: null,
		owner_pid: null,
		owner_heartbeat_at: null,
		error_count: 0,
		transitioning: false,
		cancel_requested: false,
		stop_requested: false,
		bundle_mode: false,
		loop_token: randomUUID(),
		model_provider: null,
		model_id: null,
		thinking_level: null,
		bundle_snapshot_hash: null,
		items_snapshot_hash: null,
		progress_size: null,
		progress_hash: null,
		progress_snapshot: null,
		source_doc_hashes: null,
		bundle_items_snapshot: null,
		git_head: null,
		bundle_rejection_count: 0,
		provider_recovery_fresh_fallback_used: false,
		limit_reminders: null,
		...overrides,
	};
}

async function withEnv(
	values: Record<string, string | undefined>,
	run: () => Promise<void> | void,
): Promise<void> {
	const previous = Object.fromEntries(
		Object.keys(values).map((key) => [key, process.env[key]]),
	);
	const apply = (next: Record<string, string | undefined>) => {
		for (const [key, value] of Object.entries(next)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
	apply(values);
	try {
		await run();
	} finally {
		apply(previous);
	}
}

test("publishLoopFact is a no-op without an absolute socket path", async () => {
	for (const socketPath of [undefined, "", "relative/facts.sock"]) {
		await withEnv({ [FACT_SOCKET_ENV]: socketPath }, () => {
			assert.equal(isLoopFactChannelConfigured(), false);
			assert.doesNotThrow(() =>
				publishLoopFact(makeState(), {
					kind: "iteration-start",
					phase: "entered",
				}),
			);
		});
	}
});

test("publishLoopFact frames versioned NDJSON with launch identity and sequence", async () => {
	const receiver = await startReceiver();
	try {
		await withEnv(
			{ [FACT_SOCKET_ENV]: receiver.path, [LAUNCH_ID_ENV]: "launch-1" },
			async () => {
				const state = makeState({ iteration: 4 });
				publishLoopFact(state, { kind: "iteration-start", phase: "entered" });
				publishLoopFact(state, {
					kind: "promise-decision",
					promise: "NEXT",
					accepted: false,
					reason: "Failed invariant: exactly one item",
				});
				publishLoopFact(state, { kind: "loop-ended", reason: "error" });

				await waitFor(() => receiver.frames.length === 3);
				assert.deepEqual(
					receiver.frames.map((f) => [f.version, f.sequence, f.id]),
					[1, 2, 3].map((sequence) => [
						1,
						sequence,
						JSON.stringify(["launch-1", state.loop_token, sequence]),
					]),
				);
				const [start, decision, ended] = receiver.frames;
				assert.deepEqual(start?.fact.run, {
					launchId: "launch-1",
					loopToken: state.loop_token,
					startedAt: state.started_at,
				});
				assert.equal(start?.fact.iteration, 4);
				assert.ok(!Number.isNaN(Date.parse(start?.fact.at ?? "")));
				assert.deepEqual(
					{ ...decision?.fact, at: undefined, run: undefined },
					{
						at: undefined,
						run: undefined,
						iteration: 4,
						kind: "promise-decision",
						promise: "NEXT",
						accepted: false,
						reason: "Failed invariant: exactly one item",
					},
				);
				assert.equal(ended?.fact.kind, "loop-ended");
			},
		);
	} finally {
		await receiver.close();
	}
});

test("a missing receiver drops frames without throwing, and a later receiver sees the gap", async () => {
	const path = shortSocketPath();
	await withEnv({ [FACT_SOCKET_ENV]: path, [LAUNCH_ID_ENV]: undefined }, async () => {
		const state = makeState();
		assert.doesNotThrow(() =>
			publishLoopFact(state, { kind: "iteration-start", phase: "entered" }),
		);
		// Let the asynchronous connection failure land; it must stay handled.
		await new Promise((resolve) => setTimeout(resolve, 50));

		const receiver = await startReceiver(path);
		try {
			publishLoopFact(state, {
				kind: "promise-decision",
				promise: "WAIT",
				accepted: true,
				reason: null,
			});
			await waitFor(() => receiver.frames.length === 1);
			assert.equal(receiver.frames[0]?.sequence, 2);
			assert.equal(receiver.frames[0]?.fact.run.launchId, null);
		} finally {
			await receiver.close();
		}
	});
});

test("a receiver that closes mid-run does not break later publications", async () => {
	const receiver = await startReceiver();
	try {
		await withEnv({ [FACT_SOCKET_ENV]: receiver.path }, async () => {
			const state = makeState();
			publishLoopFact(state, { kind: "iteration-start", phase: "entered" });
			await waitFor(() => receiver.frames.length === 1);

			for (const socket of receiver.connections) socket.destroy();
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.doesNotThrow(() =>
				publishLoopFact(state, { kind: "iteration-end", outcome: "NEXT" }),
			);
			await new Promise((resolve) => setTimeout(resolve, 50));
			publishLoopFact(state, { kind: "loop-ended", reason: "complete" });

			await waitFor(() =>
				receiver.frames.some((f) => f.fact.kind === "loop-ended"),
			);
			assert.equal(receiver.frames.at(-1)?.sequence, 3);
		});
	} finally {
		await receiver.close();
	}
});

test("a stalled receiver drops frames under backpressure instead of buffering", async () => {
	const receiver = await startReceiver();
	try {
		await withEnv({ [FACT_SOCKET_ENV]: receiver.path }, async () => {
			const state = makeState();
			publishLoopFact(state, { kind: "iteration-start", phase: "entered" });
			await waitFor(() => receiver.connections.length === 1);
			receiver.connections[0]?.pause();

			const reason = "x".repeat(64 * 1024);
			const published = 400;
			for (let i = 0; i < published; i++) {
				publishLoopFact(state, {
					kind: "promise-decision",
					promise: "NEXT",
					accepted: false,
					reason,
				});
			}
			receiver.connections[0]?.resume();
			await new Promise((resolve) => setTimeout(resolve, 300));

			assert.ok(receiver.frames.length > 0);
			assert.ok(
				receiver.frames.length < published + 1,
				`expected drops, received ${receiver.frames.length}`,
			);
		});
	} finally {
		await receiver.close();
	}
});

test("sequence counters survive a module reload", async () => {
	const receiver = await startReceiver();
	try {
		await withEnv({ [FACT_SOCKET_ENV]: receiver.path }, async () => {
			const state = makeState();
			publishLoopFact(state, { kind: "iteration-start", phase: "entered" });
			const reloaded = (await import(
				`../src/loop/watch-events.ts?reload=${randomUUID()}`
			)) as typeof import("../src/loop/watch-events.ts");
			assert.notEqual(reloaded.publishLoopFact, publishLoopFact);
			reloaded.publishLoopFact(state, {
				kind: "iteration-end",
				outcome: "NEXT",
			});

			await waitFor(() => receiver.frames.length === 2);
			assert.deepEqual(
				receiver.frames.map((f) => f.sequence),
				[1, 2],
			);
		});
	} finally {
		await receiver.close();
	}
});
