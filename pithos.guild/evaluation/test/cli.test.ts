import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "../src/cli.ts";

test("CLI is offline by default and rejects live runs and unknown arguments", async () => {
  const output: string[] = [];
  const log = (text: string) => { output.push(text); };
  await main([], log);
  assert.match(output[0], /offline/i);
  await main(["validate"], log);
  assert.equal(JSON.parse(output[1]).tasks.length, 6);
  await main(["schedule", "seed", "3"], log);
  assert.equal(JSON.parse(output[2]).trials.length, 36);
  for (const args of [["run"], ["validate", "--live"], ["schedule", "seed", "0"], ["schedule", "seed", "3x"]]) await assert.rejects(main(args, log));
});
