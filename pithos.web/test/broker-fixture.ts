import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export async function createBrokerFixture(
	t: TestContext,
	respond: (request: unknown, socket: Socket) => void,
	transport: "unix" | "tcp" = "unix",
) {
	const directory = transport === "unix" ? await mkdtemp(join(tmpdir(), "pwb-")) : undefined;
	const path = directory ? join(directory, "sock") : undefined;
	const requests: unknown[] = [];
	const connections = new Set<Socket>();
	let accepted = 0;
	const server = createServer((socket) => {
		accepted += 1;
		connections.add(socket);
		socket.once("close", () => connections.delete(socket));
		socket.on("error", () => {});
		socket.setEncoding("utf8");
		let frame = "";
		const readRequest = (text: string) => {
			frame += text;
			if (!frame.includes("\n")) return;
			socket.off("data", readRequest);
			assert.equal(frame.indexOf("\n"), frame.length - 1);
			const request: unknown = JSON.parse(frame);
			requests.push(request);
			respond(request, socket);
		};
		socket.on("data", readRequest);
	});
	t.after(async () => {
		for (const socket of connections) socket.destroy();
		if (server.listening) await once(server.close(), "close");
		if (directory) await rm(directory, { recursive: true, force: true });
	});
	await once(path ? server.listen(path) : server.listen(0, "127.0.0.1"), "listening");
	const address = server.address();
	const port = address && typeof address !== "string" ? address.port : undefined;
	return {
		env: {
			PITHOS_WEB_SEARCH_STATUS: "ready",
			PITHOS_WEB_SEARCH_TOKEN: "a1".repeat(32),
			PITHOS_WEB_SEARCH_SOCKET: path,
			PITHOS_WEB_SEARCH_PORT: port?.toString(),
		},
		port,
		requests,
		get accepted() { return accepted; },
	};
}
