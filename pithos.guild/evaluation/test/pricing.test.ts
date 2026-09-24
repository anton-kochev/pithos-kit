import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateBaseCost, validateBasePricing } from "../src/pricing.ts";

const policy = { version: 1 as const, model: "test/fake", api: "test-api", serviceTier: "base" as const,
  cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 3 } };

test("prices each usage category per million without modifying the inputs", () => {
  const usage = { input: 1000000, output: 500000, cacheRead: 2000000, cacheWrite: 1000000, totalTokens: 4500000 };
  const before = structuredClone({ policy, usage });
  assert.deepEqual(calculateBaseCost(policy, usage), { input: 2, output: 4, cacheRead: 1, cacheWrite: 3, total: 10 });
  assert.deepEqual({ policy, usage }, before);
});

test("selects the highest strictly exceeded input tier, including cached input, separately per turn", () => {
  const tiered = { ...policy, cost: { ...policy.cost, tiers: [
    { inputTokensAbove: 200, input: 6, output: 24, cacheRead: 1.5, cacheWrite: 9 },
    { inputTokensAbove: 100, input: 4, output: 16, cacheRead: 1, cacheWrite: 6 },
  ] } };
  for (const [cached, expectedOutputRate] of [[99, 8], [100, 16], [199, 16], [200, 24]]) {
    const usage = { input: 1, output: 1000000, cacheRead: cached - 1, cacheWrite: 1, totalTokens: 1000001 + cached };
    assert.equal(calculateBaseCost(tiered, usage).output, expectedOutputRate);
  }
  const turn = { input: 100, output: 1000000, cacheRead: 0, cacheWrite: 0, totalTokens: 1000100 };
  assert.equal(calculateBaseCost(tiered, turn).output + calculateBaseCost(tiered, turn).output, 16);
});

test("rejects malformed or unsupported pricing policies and returns a detached validated policy", () => {
  const tier = { inputTokensAbove: 100, ...policy.cost };
  const mutations: ((p: any) => void)[] = [
    p => p.version = 2, p => p.extra = true, p => p.model = "bare", p => p.api = "", p => p.serviceTier = "priority",
    p => p.cost.input = -1, p => p.cost.output = Infinity, p => p.cost.cacheRead = "1", p => p.cost.cacheWrite = 1000001,
    p => p.cost.currency = "USD", p => delete p.cost.input, p => p.cost.tiers = null,
    p => p.cost.tiers = Array(17).fill(tier), p => p.cost.tiers = [tier, tier],
    p => p.cost.tiers = [{ ...tier, inputTokensAbove: 0.5 }], p => p.cost.tiers = [{ ...tier, inputTokensAbove: -1 }],
    p => p.cost.tiers = [{ ...tier, inputTokensAbove: Number.MAX_SAFE_INTEGER + 1 }], p => p.cost.tiers = [{ ...tier, output: NaN }],
    p => p.cost.tiers = [{ ...tier, extra: true }],
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(policy); mutate(changed);
    assert.throws(() => validateBasePricing(changed), /Invalid base pricing policy/);
  }
  for (const invalid of [null, [], undefined, 1]) assert.throws(() => validateBasePricing(invalid), /pricing/);
  const checked = validateBasePricing(policy);
  checked.cost.input = 99;
  assert.equal(policy.cost.input, 2);
});

test("rejects missing, fractional, inconsistent or unsafe usage and unsupported cache semantics", () => {
  const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 };
  for (const changed of [
    { ...usage, input: -1 }, { ...usage, output: 0.5 }, { ...usage, cacheRead: NaN }, { ...usage, cacheWrite: Infinity },
    { ...usage, totalTokens: 9 }, { ...usage, input: Number.MAX_SAFE_INTEGER, totalTokens: Number.MAX_SAFE_INTEGER },
    { ...usage, cacheWrite1h: 1 }, { ...usage, cacheWrite1h: null }, { ...usage, output: "2" }, {}, null,
  ]) assert.throws(() => calculateBaseCost(policy, changed as any), /Invalid pricing usage/);
  assert.throws(() => calculateBaseCost({ ...policy, serviceTier: "flex" } as any, usage), /pricing policy/);
});
