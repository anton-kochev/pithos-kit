import { AsyncLocalStorage } from "node:async_hooks";
import assert from "node:assert/strict";

// Emulate Pi's command-before-input routing and synchronous extension-input
// admission. Agent startup remains explicit so tests can exercise supersession.
export function commandHarness(handlers: Map<string, any>) {
	const commands = new Map<string, any>();
	const routes = new AsyncLocalStorage<{ sent: string[]; ctx: any }>();
	let startScope: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined;
	return {
		wrapStart(handler: any) {
			return (event: any, ctx: any) => {
				const scope = startScope;
				startScope = undefined;
				return scope ? scope(handler, event, ctx) : handler(event, ctx);
			};
		},
		registerCommand(name: string, command: any) { commands.set(name, command); },
		sendUserMessage(text: string) {
			startScope = AsyncLocalStorage.snapshot();
			const route = routes.getStore();
			assert.ok(route);
			route.sent.push(text);
			void handlers.get("input")?.({ type: "input", source: "extension", text }, route.ctx);
		},
		async route(ctx: any, text: string, streamingBehavior?: string) {
			if (text === "/plan" || text.startsWith("/plan ")) {
				const command = commands.get("plan");
				assert.ok(command, "/plan must be a registered command");
				const route = { sent: [] as string[], ctx: { ...ctx, isIdle: () => !streamingBehavior && ctx.isIdle() } };
				await routes.run(route, () => command.handler(text.slice(5).trim(), route.ctx));
				return route.sent.length > 0
					? { action: "dispatched", text: route.sent.at(-1) }
					: { action: "handled" };
			}
			return handlers.get("input")?.({ type: "input", source: "interactive", text, streamingBehavior }, ctx);
		},
	};
}
