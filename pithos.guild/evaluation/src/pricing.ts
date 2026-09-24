export interface BasePricing {
  version: 1;
  model: string;
  api: string;
  serviceTier: "base";
  cost: Rates & { tiers?: (Rates & { inputTokensAbove: number })[] };
}
interface Rates { input: number; output: number; cacheRead: number; cacheWrite: number }
interface Counts extends Rates { totalTokens: number; cacheWrite1h?: number }
const categories = ["input", "output", "cacheRead", "cacheWrite"] as const;
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function exact(value: any, keys: string[]) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function validateBasePricing(raw: unknown): BasePricing {
  const p = raw as BasePricing, error = "Invalid base pricing policy";
  check(exact(p, ["version", "model", "api", "serviceTier", "cost"]), error);
  check(p.version === 1 && p.serviceTier === "base" && typeof p.model === "string" && p.model.length <= 256
    && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(p.model) && typeof p.api === "string" && /^[a-zA-Z0-9_.-]{1,128}$/.test(p.api), error);
  const validRates = (r: Rates) => categories.every(key => typeof r[key] === "number" && Number.isFinite(r[key]) && r[key] >= 0 && r[key] <= 1000000);
  check(exact(p.cost, [...categories, ...(p.cost && Object.hasOwn(p.cost, "tiers") ? ["tiers"] : [])]) && validRates(p.cost), error);
  if (Object.hasOwn(p.cost, "tiers")) {
    check(Array.isArray(p.cost.tiers) && p.cost.tiers.length <= 16, error);
    const seen = new Set<number>();
    for (const tier of p.cost.tiers) {
      check(exact(tier, [...categories, "inputTokensAbove"]) && validRates(tier)
        && Number.isSafeInteger(tier.inputTokensAbove) && tier.inputTokensAbove >= 0 && !seen.has(tier.inputTokensAbove), error);
      seen.add(tier.inputTokensAbove);
    }
  }
  return structuredClone(p);
}
export function calculateBaseCost(policy: BasePricing, usage: Counts) {
  policy = validateBasePricing(policy);
  const error = "Invalid pricing usage";
  check(usage && categories.every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0)
    && (usage.cacheWrite1h === undefined || usage.cacheWrite1h === 0), error);
  const total = categories.reduce((sum, key) => sum + usage[key], 0);
  check(Number.isSafeInteger(total) && usage.totalTokens === total, error);
  let rates: Rates = policy.cost, threshold = -1;
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  for (const tier of policy.cost.tiers ?? []) if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
    rates = tier; threshold = tier.inputTokensAbove;
  }
  const input = rates.input / 1000000 * usage.input, output = rates.output / 1000000 * usage.output;
  const cacheRead = rates.cacheRead / 1000000 * usage.cacheRead, cacheWrite = rates.cacheWrite * usage.cacheWrite / 1000000;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}
// Arithmetic agreement only: does not establish provider metering or service-tier provenance.
export function matchesBasePricing(policy: BasePricing, message: any): boolean {
  try {
    if (`${message.provider}/${message.model}` !== policy.model || message.api !== policy.api
      || !(message.usage.output > 0) || !(message.usage.input + message.usage.cacheRead + message.usage.cacheWrite > 0)) return false;
    const computed = calculateBaseCost(policy, message.usage);
    return exact(message.usage.cost, [...categories, "total"])
      && [...categories, "total" as const].every(key => message.usage.cost[key] === computed[key]);
  } catch { return false; }
}
