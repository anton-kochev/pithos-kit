/** Public-loader fixture: only dependency seams and observers; Guild owns shutdown. */
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { registerGuild, type GuildDependencies } from "../../src/guild.ts";

export default function shutdownProbeGuild(pi: ExtensionAPI) {
  const control = {
    SessionManager, createAssistantMessageEventStream, TuiMainScreen,
    veto: false, shutdowns: 0, starts: 0, traceBindings: 0, unbinds: 0,
    failCleanup: false,
    context: undefined as ExtensionContext | undefined,
    observe: (_event: string) => {},
    run: (async () => { throw new Error("Unconfigured in-process runner"); }) as GuildDependencies["run"],
  };
  pi.events.on("shutdown-probe:control", reply => {
    if (typeof reply !== "function") throw new Error("Expected observer callback");
    reply(control);
  });
  pi.on("session_before_switch", () => control.veto ? { cancel: true } : undefined);
  pi.on("session_shutdown", () => { control.shutdowns++; });
  pi.on("session_start", (_event, ctx) => { control.starts++; control.context = ctx; });
  registerGuild(pi, {
    run: options => control.run(options),
    captureRepoState: async () => ({ state: "memory-only", head: "fixture", dirty: false, complete: true }),
    createTraceRecorder: () => ({
      bind: () => {
        control.traceBindings++;
        return () => {
          control.unbinds++;
          control.observe("unbind");
          if (control.failCleanup) throw new Error("scripted-trace-cleanup-failure");
        };
      },
      dispose() {},
    }),
  });
}
