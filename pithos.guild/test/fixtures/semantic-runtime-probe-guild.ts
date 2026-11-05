/** Production Guild registration with local deterministic runner and nested-call test controls. */
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { registerGuild, type GuildDependencies } from "../../src/guild.ts";
import { createGuildBackgroundRuntime, type GuildExecutionRuntime } from "../../src/background-runtime.ts";
import type { GuildOwner } from "../../src/execution-authority.ts";
import type { RunBackgroundGuildRoleOptions } from "../../src/background-runner.ts";
import type { GuildRoleRunResult } from "../../src/runner.ts";
import { Type } from "typebox";
import { createSemanticInterruptBinding } from "../../src/semantic-interrupt.ts";

// This oracle deliberately qualifies the legacy atomic fallback, not continuation wake.
// Forward getters and methods with the original receiver without mutating SDK contexts.
function legacyContext<T extends object>(context: T): T {
  return new Proxy(context, { get(target, key) {
    if (key === "parentContinuation") return undefined;
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
function legacyCallback<T extends Function>(callback: T): T {
  return new Proxy(callback, { apply(target, receiver, args) {
    const forwarded = [...args];
    forwarded[forwarded.length - 1] = legacyContext(forwarded[forwarded.length - 1]);
    return Reflect.apply(target, receiver, forwarded);
  } });
}
function legacyApi(pi: ExtensionAPI): ExtensionAPI {
  return new Proxy(pi, { get(target, key) {
    if (key === "on") return new Proxy(target.on, { apply(method, _receiver, args) {
      return Reflect.apply(method, target, [args[0], legacyCallback(args[1])]);
    } });
    if (key === "registerTool") return new Proxy(target.registerTool, { apply(method, _receiver, args) {
      return Reflect.apply(method, target, [{ ...args[0], execute: legacyCallback(args[0].execute) }]);
    } });
    if (key === "registerCommand") return new Proxy(target.registerCommand, { apply(method, _receiver, args) {
      return Reflect.apply(method, target, [args[0], { ...args[1], handler: legacyCallback(args[1].handler) }]);
    } });
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

export default function semanticProbeGuild(pi: ExtensionAPI) {
  let capturedMode = "standalone";
  pi.events.emit("semantic-probe:policy", (mode: string) => {
    if (mode !== "required") throw new Error("Invalid fixture policy");
    capturedMode = mode;
  });
  const control = {
    SessionManager, TuiMainScreen, createAssistantMessageEventStream, createSemanticInterruptBinding,
    runtime: undefined as GuildExecutionRuntime | undefined,
    owner: undefined as GuildOwner | undefined,
    context: undefined as ExtensionContext | undefined,
    activations: 0, starts: 0, shutdowns: 0, allowAgent: false,
    onStart: () => {}, onShutdown: () => {},
    run: (async () => { throw new Error("Unconfigured direct runner"); }) as GuildDependencies["run"],
    background: async (_options: RunBackgroundGuildRoleOptions): Promise<GuildRoleRunResult> => { throw new Error("Unconfigured background runner"); },
  };
  pi.events.on("semantic-probe:control", reply => {
    if (typeof reply !== "function") throw new Error("Expected control observer");
    reply(control);
  });
  pi.registerTool({
    name: "semantic_nested_wait", label: "Nested wait probe", description: "Exercise nested collection refusal",
    parameters: Type.Object({runId: Type.String()}),
    async execute(_id, args, _signal, _update, ctx) {
      const details = await ctx.executeTool("guild_wait", {runId: args.runId, timeoutMs: 0});
      return {content: [{type: "text", text: "Nested outcome observed"}], details};
    },
  });
  pi.registerCommand("semantic-probe-reload", {
    description: "Provider-free public reload probe",
    handler: async (_args, ctx) => { await ctx.reload(); },
  });
  pi.on("session_start", (_event, ctx) => { control.context = ctx; control.starts++; control.onStart(); });
  // Registered before Guild: observes the reset prefix before Guild's shutdown handler.
  pi.on("session_shutdown", () => { control.shutdowns++; control.onShutdown(); });
  registerGuild(legacyApi(pi), {
    createExecutionRuntime(options) {
      const runtime = createGuildBackgroundRuntime({ ...options,
        parentEnvironment: { PITHOS_GUILD_PLAN_MODE: capturedMode },
        runner: options => control.background(options),
      });
      control.runtime = runtime;
      return { ...runtime, activate() {
        control.activations++;
        control.owner = runtime.activate();
        return control.owner;
      } };
    },
    run: options => control.run(options),
    captureRepoState: async () => ({ state: "memory-only", head: "fixture", dirty: false, complete: true }),
    createTraceRecorder: () => ({ bind: () => () => {}, dispose() {} }),
  });
  // Only explicit local-script turns enter the agent loop; ordinary test intent is consumed.
  pi.on("input", event => control.allowAgent || event.text.startsWith("/plan") ? undefined : ({ action: "handled" }));
}
