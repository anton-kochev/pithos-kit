// Fixed Guild probe only; ordinary children inherit this preload, but not FD 3.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { assertNetworkIsolation, currentNetworkState } from "./offline-state.ts";
import { admitGuildActor } from "./offline-guild-admission.ts";
import { readNativeConfig } from "./native-config.ts";
import { syntheticTransport } from "./offline-synthetic.ts";
import { openDiagnostics, installChildDiagnostics } from "./offline-diagnostics.ts";

try {
  const root = "/opt/pi-npm/lib/node_modules/@earendil-works/pi-coding-agent";
  if (process.argv[1] !== `${root}/dist/cli.js`) throw Error();
  const state = assertNetworkIsolation(currentNetworkState());
  const readiness = JSON.parse(readFileSync("/evidence/verification.json", "utf8"));
  const config = readNativeConfig(process.env.GUILD_EVAL_NATIVE_CONFIG!, process.env.GUILD_EVAL_NATIVE_CONFIG_SHA256!);
  const directory = "/evidence/synthetic-guild";
  const parent = process.ppid === config.launchParentPid ? undefined : JSON.parse(readFileSync(`${directory}/parent.json`, "utf8"));
  const actor = admitGuildActor(config, readiness, state, process.pid, process.ppid, parent);
  const diagnostic = openDiagnostics(`${directory}/diagnostics/${process.pid}.jsonl`);
  diagnostic.emit({ type: "bootstrap_start" });
  const dispose = actor === "parent" ? installChildDiagnostics(`${root}/dist/cli.js`, event => { diagnostic.emit(event); }) : () => {};
  process.once("exit", code => {
    dispose(); diagnostic.emit({ type: "process_exit", code });
    if (!diagnostic.close()) process.stderr.write("Synthetic diagnostics incomplete\n");
  });
  const identity = { pid: process.pid, ppid: process.ppid, ...state };
  if (actor === "parent") writeFileSync(`${directory}/parent.json`, JSON.stringify(identity), { flag: "wx", mode: 0o600 });
  // Preserve Pi 0.85.1's intentional-global-override check, as in main-only mode.
  await import(pathToFileURL(`${root}/dist/core/http-dispatcher.js`).href);
  diagnostic.emit({ type: "dispatcher_ready" });
  const transport = syntheticTransport({ actor: actor === "parent" ? "guild-parent" : "guild-child", identity: `${actor}-${process.pid}` });
  globalThis.fetch = transport.fetch; globalThis.WebSocket = transport.WebSocket;
  process.once("exit", () => writeFileSync(`${directory}/transports/${process.pid}.json`, JSON.stringify({ version: 1, ...identity, actor, stats: transport.snapshot() }), { flag: "wx", mode: 0o600 }));
  diagnostic.emit({ type: "native_preload_start" });
  await import("./native-preload.ts");
  diagnostic.emit({ type: "native_preload_ready" });
  if (actor === "parent") { await import("./child-observer.ts"); diagnostic.emit({ type: "telemetry_ready" }); }
} catch { process.stderr.write("Synthetic Guild bootstrap rejected\n"); process.exit(1); }
