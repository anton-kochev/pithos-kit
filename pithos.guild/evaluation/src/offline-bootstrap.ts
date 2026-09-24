// Only the fixed, network-isolated synthetic CLI probe may load this preload.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { assertNetworkIsolation, currentNetworkState } from "./offline-state.ts";
import { readNativeConfig } from "./native-config.ts";
import { syntheticTransport } from "./offline-synthetic.ts";

try {
  const root = "/opt/pi-npm/lib/node_modules/@earendil-works/pi-coding-agent";
  if (process.argv[1] !== `${root}/dist/cli.js`) throw Error();
  const state = assertNetworkIsolation(currentNetworkState());
  const readiness = JSON.parse(readFileSync("/evidence/verification.json", "utf8"));
  if (readiness.parent.pid !== process.ppid || readiness.parent.checks.namespace !== state.namespace || readiness.parent.checks.uid !== state.uid) throw Error();
  const config = readNativeConfig(process.env.GUILD_EVAL_NATIVE_CONFIG!, process.env.GUILD_EVAL_NATIVE_CONFIG_SHA256!);
  if (config.arm !== "main-only" || config.launchParentPid !== process.ppid || config.directory !== "/evidence/synthetic/native") throw Error();
  // Capture the original fetch in Pi's dispatcher module BEFORE replacing it.
  // configureHttpDispatcher then preserves the intentional later replacement.
  await import(pathToFileURL(`${root}/dist/core/http-dispatcher.js`).href);
  const transport = syntheticTransport();
  globalThis.fetch = transport.fetch; globalThis.WebSocket = transport.WebSocket;
  process.on("exit", () => writeFileSync(join(config.directory, "..", "synthetic-transport.json"), JSON.stringify(transport.snapshot()), { flag: "wx", mode: 0o600 }));
  await import("./native-preload.ts");
} catch { process.stderr.write("Synthetic bootstrap rejected\n"); process.exit(1); }
