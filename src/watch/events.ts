import { connect } from "node:net";
import { ControlError, parseEventFrame, readMetadata } from "./transport.js";
import type { EventFrame, RunKey } from "./types.js";

/** Read-only replay then live stream. Pull-based reads leave backpressure local. */
export async function* connectEvents(target: { root: string; run?: RunKey }, signal?: AbortSignal): AsyncIterable<EventFrame> {
	if (signal?.aborted) return;
	const metadata = readMetadata(target.root);
	const socket = connect(metadata.eventSocket);
	const abort = () => socket.destroy();
	signal?.addEventListener("abort", abort, { once: true });
	let buffer = "";
	let first = true;
	let closed = false;
	socket.setEncoding("utf8");
	try {
		for await (const chunk of socket) {
			buffer += chunk;
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const frame = parseEventFrame(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				if (!frame) throw new ControlError("disconnected", "Invalid event frame");
				if (first) {
					if (frame.type !== "hello") throw new ControlError("disconnected", "Missing hello frame");
					if (metadata.launchId !== frame.launchId || (target.run?.launchId != null && target.run.launchId !== frame.launchId) || (target.run?.loopToken != null && target.run.loopToken !== frame.loop?.token)) throw new ControlError("wrong-run", "Driver run changed");
					first = false;
				} else if (frame.type === "hello") throw new ControlError("disconnected", "Unexpected hello frame");
				if (frame.type === "lifecycle" && frame.state === "closed") closed = true;
				yield frame;
				if (closed) return;
			}
		}
		if (!signal?.aborted && !closed) throw new ControlError("disconnected", "Driver event stream closed unexpectedly");
	} catch (error) {
		if (signal?.aborted) return;
		if (error instanceof ControlError) throw error;
		throw new ControlError("disconnected", String(error));
	} finally { signal?.removeEventListener("abort", abort); socket.destroy(); }
}

