import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureProcess } from "../src/offline-capture.ts";

test("optional child telemetry descriptor is private and separate from model stdout", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-offline-capture-"));
  try {
    const outcome = await captureProcess(process.execPath, ["-e", 'require("node:fs").writeSync(3, "telemetry"); process.stdout.write("model");'], root, {}, root, 3000, true);
    assert.equal(outcome.status, 0);
    assert.equal(await readFile(join(root, "children.jsonl"), "utf8"), "telemetry");
    assert.equal(await readFile(join(root, "stdout.jsonl"), "utf8"), "model");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("retains bounded partial output and kills a timed-out inert process group", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-offline-capture-"));
  try {
    const outcome = await captureProcess(process.execPath, ["-e", 'process.stdout.write("partial"); setInterval(() => {}, 1000);'], root, {}, root, 300);
    assert.equal(outcome.timedOut, true); assert.equal(outcome.signal, "SIGKILL");
    assert.equal(await readFile(join(root, "stdout.jsonl"), "utf8"), "partial");
  } finally { await rm(root, { recursive: true, force: true }); }
});
