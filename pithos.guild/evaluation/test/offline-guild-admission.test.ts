import assert from "node:assert/strict";
import { test } from "node:test";
import { admitGuildActor } from "../src/offline-guild-admission.ts";

test("Guild bootstrap admits only a fresh isolated parent or its direct child", () => {
  const config = { arm: "guild-available", directory: "/evidence/synthetic-guild/native", launchParentPid: 7 };
  const state = { namespace: "net:[123]", uid: 501 };
  const readiness = { parent: { pid: 7, checks: state } };
  const parent = { pid: 25, ppid: 7, ...state };
  assert.equal(admitGuildActor(config, readiness, state, 25, 7), "parent");
  assert.equal(admitGuildActor(config, readiness, state, 32, 25, parent), "child");
  for (const [c, r, s, pid, ppid, p] of [
    [config, readiness, state, 33, 32, parent],
    [config, readiness, { ...state, namespace: "net:[456]" }, 32, 25, parent],
    [config, readiness, state, 25, 25, parent],
    [config, readiness, state, 32, 25, { ...parent, ppid: 9 }],
    [{ ...config, arm: "main-only" }, readiness, state, 25, 7, undefined],
    [{ ...config, launchParentPid: 8 }, readiness, state, 25, 7, undefined],
  ] as any[]) assert.throws(() => admitGuildActor(c, r, s, pid, ppid, p), /Synthetic Guild ancestry mismatch/);
});
