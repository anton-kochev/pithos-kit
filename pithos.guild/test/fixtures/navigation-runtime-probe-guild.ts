/** Public-loader fixture: production Guild owns all lifecycle and scheduling handlers. */
import { VERSION, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { registerGuild, type GuildDependencies } from "../../src/guild.ts";
import { createGuildBackgroundRuntime } from "../../src/background-runtime.ts";

export default function navigationProbeGuild(pi: ExtensionAPI) {
  const control = {
    sdkVersion: VERSION, SessionManager, createAssistantMessageEventStream, traceBindings: 0,
    activations: 0, failCleanup: false, cleanupFaults: 0,
    run: (async () => { throw new Error("Unconfigured probe runner must never launch a child"); }) as GuildDependencies["run"],
  };
  pi.events.on("navigation-probe:control", reply => {
    if (typeof reply !== "function") throw new Error("Probe control requires an observer callback");
    reply(control);
  });
  registerGuild(pi, {
    createExecutionRuntime: options => {
      const runtime = createGuildBackgroundRuntime(options);
      return { ...runtime, activate() { control.activations++; return runtime.activate(); } };
    },
    run: options => control.run(options),
    captureRepoState: async () => ({ state: "memory-only", head: "fixture", dirty: false, complete: true }),
    createTraceRecorder: () => ({
      bind: () => {
        control.traceBindings++;
        return () => {
          if (control.failCleanup) {
            control.cleanupFaults++;
            throw new Error("scripted-trace-cleanup-failure");
          }
        };
      },
      dispose() {},
    }),
  });
}
