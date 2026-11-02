/** Public-loader fixture: dependency seams and counters, never Plan attachment/state. */
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { registerGuild, type GuildDependencies } from "../../src/guild.ts";
import { createGuildBackgroundRuntime } from "../../src/background-runtime.ts";

export default function planProbeGuild(pi: ExtensionAPI) {
  const control = {
    SessionManager, createAssistantMessageEventStream,
    starts: 0, shutdowns: 0, captures: 0, bindings: 0, unbinds: 0, calls: 0,
    agentStarts: 0, activations: 0,
    context: undefined as ExtensionContext | undefined,
    run: (async () => { throw new Error("Unconfigured runner"); }) as GuildDependencies["run"],
  };
  pi.events.on("plan-probe:control", reply => {
    if (typeof reply !== "function") throw new Error("Expected observer callback");
    reply(control);
  });
  pi.on("session_start", (_event, ctx) => { control.starts++; control.context = ctx; });
  pi.on("session_shutdown", () => { control.shutdowns++; });
  pi.on("agent_start", () => { control.agentStarts++; });
  registerGuild(pi, {
    createExecutionRuntime: options => {
      const runtime = createGuildBackgroundRuntime(options);
      return { ...runtime, activate() { control.activations++; return runtime.activate(); } };
    },
    run: options => { control.calls++; return control.run(options); },
    captureRepoState: async () => {
      control.captures++;
      return { state: "memory-only", head: "fixture", dirty: false, complete: true };
    },
    createTraceRecorder: () => ({
      bind: () => { control.bindings++; return () => { control.unbinds++; }; },
      dispose() {},
    }),
  });
}
