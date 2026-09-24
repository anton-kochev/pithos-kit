import { pathToFileURL } from "node:url";
import { loadDevelopmentBank } from "./bank.ts";
import { digest } from "./manifest.ts";
import { createSchedule } from "./runner.ts";

export async function main(args: string[], log: (text: string) => void = console.log): Promise<void> {
  if (args.length === 0 || (args.length === 1 && args[0] === "help")) {
    log(`Guild E1 — offline evaluation preflight\n\nCommands:\n  npm run eval -- validate\n  npm run eval -- schedule <seed> <1-5 repetitions>\n  npm run eval:test\n  npm run eval:typecheck\n\nNo live-run command is enabled. Approve the concrete bank, cohort, budget and telemetry limitations first.`);
    return;
  }
  const bank = loadDevelopmentBank();
  if (args[0] === "validate" && args.length === 1) {
    log(JSON.stringify({ version: 1, bankDigest: digest(bank), tasks: bank.tasks.map(({ id, split, fixtureDigest, grader, delegation }) => ({ id, split, fixtureDigest, grader, delegation })) }, null, 2));
    return;
  }
  if (args[0] === "schedule" && args.length === 3 && /^[1-5]$/.test(args[2])) {
    log(JSON.stringify({ version: 1, evidence: "development-only; not promotion", bankDigest: digest(bank), seed: args[1], trials: createSchedule(bank, Number(args[2]), args[1]) }, null, 2));
    return;
  }
  throw new Error("Unknown or invalid command. Live runs require separate user approval; use 'help'.");
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error(String(error)); process.exitCode = 1; });
}
