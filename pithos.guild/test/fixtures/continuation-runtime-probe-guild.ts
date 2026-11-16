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
import { childTools, BACKGROUND_CAPABILITY } from "../../src/protocol.ts";
import { createSemanticInterruptBinding } from "../../src/semantic-interrupt.ts";

// Observe only public capability calls. Proxies retain the actual SDK receivers,
// receipts and promises; they never supply acceptance or schedule native work.
type Acceptance = {lease: object; sequence: number; content: string; receipt: unknown};
type Opening = {context: object; args: unknown[]; lease: unknown};
function observeApi(pi: ExtensionAPI, observer: {
  accept(value: Acceptance): void;
  open(value: Opening): void;
  close(lease: object, args: unknown[], result: unknown): void;
}): ExtensionAPI {
  function context<T extends object>(ctx: T): T {
    return new Proxy(ctx, {get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (key === "parentContinuation" && value && typeof value === "object") return new Proxy(value, {get(capability, member) {
        const method = Reflect.get(capability, member, capability);
        if (member === "open") return (...args: unknown[]) => {
          if (typeof method !== "function") throw new Error("Expected public open method");
          const lease = Reflect.apply(method, capability, args);
          observer.open({context: target, args, lease});
          if (!lease) return lease;
          return new Proxy(lease, {get(resource, operation) {
            const fn = Reflect.get(resource, operation, resource);
            if (operation === "tryAccept") return (sequence: number, content: string) => {
              const result = Reflect.apply(fn, resource, [sequence, content]);
              if (result && typeof result === "object" && "status" in result && result.status === "accepted" && "receipt" in result) observer.accept({lease: resource, sequence, content, receipt: result.receipt});
              return result;
            };
            if (operation === "close" && typeof fn === "function") return (...args: unknown[]) => {
              const result: unknown = Reflect.apply(fn, resource, args);
              observer.close(resource, args, result);
              return result;
            };
            return typeof fn === "function" ? fn.bind(resource) : fn;
          }});
        };
        return typeof method === "function" ? method.bind(capability) : method;
      }});
      return typeof value === "function" ? value.bind(target) : value;
    }});
  }
  function callback<T extends Function>(fn: T): T {
    return new Proxy(fn, {apply(target, receiver, args) {
      const forwarded = [...args];
      forwarded[forwarded.length - 1] = context(forwarded[forwarded.length - 1]);
      return Reflect.apply(target, receiver, forwarded);
    }});
  }
  return new Proxy(pi, {get(target, key) {
    if (key === "on") return new Proxy(target.on, {apply(method, _receiver, args) {
      return Reflect.apply(method, target, [args[0], callback(args[1])]);
    }});
    if (key === "registerTool") return new Proxy(target.registerTool, {apply(method, _receiver, args) {
      return Reflect.apply(method, target, [{...args[0], execute: callback(args[0].execute)}]);
    }});
    if (key === "registerCommand") return new Proxy(target.registerCommand, {apply(method, _receiver, args) {
      return Reflect.apply(method, target, [args[0], {...args[1], handler: callback(args[1].handler)}]);
    }});
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  }});
}

export default function continuationProbeGuild(pi: ExtensionAPI) {
  let capturedMode = "standalone";
  pi.events.emit("semantic-probe:policy", (mode: string) => {
    if (mode !== "required") throw new Error("Invalid fixture policy");
    capturedMode = mode;
  });
  const control = {
    SessionManager, TuiMainScreen, createAssistantMessageEventStream, createSemanticInterruptBinding,
    writerTools: childTools("writer", BACKGROUND_CAPABILITY),
    runtime: undefined as GuildExecutionRuntime | undefined,
    owner: undefined as GuildOwner | undefined,
    context: undefined as ExtensionContext | undefined,
    accepted: [] as Acceptance[],
    opens: [] as Opening[],
    closes: [] as {lease: object; args: unknown[]; result: unknown}[],
    onAccept: (_value: Acceptance) => {},
    onOpen: (_value: Opening) => {},
    activations: 0, starts: 0, shutdowns: 0, allowAgent: false,
    onStart: () => {}, onShutdown: () => {},
    onBeforeTree: (_event: unknown, _ctx: ExtensionContext) => {},
    beforeAgent: async (_event: unknown) => {},
    onSettled: async (_event: unknown, _ctx: ExtensionContext) => {},
    run: (async () => { throw new Error("Unconfigured direct runner"); }) as GuildDependencies["run"],
    background: async (_options: RunBackgroundGuildRoleOptions): Promise<GuildRoleRunResult> => { throw new Error("Unconfigured background runner"); },
  };
  pi.events.on("semantic-probe:control", reply => {
    if (typeof reply !== "function") throw new Error("Expected control observer");
    reply(control);
  });
  pi.on("before_agent_start", event => control.beforeAgent(event));
  pi.on("agent_settled", async (event, ctx) => { await control.onSettled(event, ctx); });
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
  // Observe the actual transition event before Guild starts its joining cleanup.
  pi.on("session_before_tree", (event, ctx) => control.onBeforeTree(event, ctx));
  const priorMode = process.env.PITHOS_GUILD_PLAN_MODE;
  process.env.PITHOS_GUILD_PLAN_MODE = capturedMode;
  try { registerGuild(observeApi(pi, {
    accept(value) { control.accepted.push(value); control.onAccept(value); },
    open(value) { control.opens.push(value); control.onOpen(value); },
    close(lease, args, result) { control.closes.push({lease, args, result}); },
  }), {
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
  } finally {
    if (priorMode === undefined) delete process.env.PITHOS_GUILD_PLAN_MODE;
    else process.env.PITHOS_GUILD_PLAN_MODE = priorMode;
  }
  // Only explicit local-script turns enter the agent loop; ordinary test intent is consumed.
  pi.on("input", event => control.allowAgent || event.text.startsWith("/plan") ? undefined : ({ action: "handled" }));
}
