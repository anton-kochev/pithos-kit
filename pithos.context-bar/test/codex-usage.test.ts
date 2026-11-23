import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CODEX_USAGE_ENDPOINT,
  fetchCodexUsage,
  formatCodexUsageDetails,
  formatCodexUsageFooter,
  parseCodexUsage,
} from "../src/codex-usage.ts";

const NOW = Date.UTC(2026, 7, 19, 20, 0, 0);
const HOUR_MS = 3_600_000;

function usagePayload(primary = 68, secondary = 74) {
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: primary,
        limit_window_seconds: 18_000,
        reset_after_seconds: 3_600,
        reset_at: NOW / 1000 + 3_600,
      },
      secondary_window: {
        used_percent: secondary,
        limit_window_seconds: 604_800,
        reset_after_seconds: 172_800,
        reset_at: NOW / 1000 + 172_800,
      },
    },
  };
}

function token(accountId = "account-123"): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.signature`;
}

describe("Codex usage parsing and formatting", () => {
  it("parses the two rolling windows as used percentages", () => {
    const usage = parseCodexUsage(usagePayload(), NOW);

    assert.deepEqual(usage, {
      plan: "plus",
      fetchedAt: NOW,
      primary: { usedPercent: 68, resetAt: NOW + 3_600_000 },
      secondary: { usedPercent: 74, resetAt: NOW + 172_800_000 },
    });
  });

  it("formats each footer countdown in whole days or hours at render time", () => {
    const usage = {
      fetchedAt: NOW,
      primary: { usedPercent: 20, resetAt: NOW + 3 * HOUR_MS },
      secondary: { usedPercent: 6, resetAt: NOW + 6 * 24 * HOUR_MS },
    };

    assert.equal(
      formatCodexUsageFooter(usage, true, NOW + 1),
      "Codex · 5h 20% (resets in 2h) · week 6% (resets in 5d) · stale",
    );
  });

  it("switches footer countdown units at whole-day and whole-hour boundaries", () => {
    for (const [milliseconds, expected] of [
      [24 * HOUR_MS, "1d"],
      [24 * HOUR_MS - 1, "23h"],
      [HOUR_MS, "1h"],
      [HOUR_MS - 1, "<1h"],
      [1, "<1h"],
    ] as const) {
      const usage = { fetchedAt: NOW, primary: {}, secondary: { usedPercent: 6, resetAt: NOW + milliseconds } };
      assert.equal(formatCodexUsageFooter(usage, false, NOW), `Codex · week 6% (resets in ${expected})`);
    }
  });

  it("keeps the last observed percentages when footer resets are due", () => {
    const usage = {
      fetchedAt: NOW,
      primary: { usedPercent: 20, resetAt: NOW + 1 },
      secondary: { usedPercent: 6, resetAt: NOW + 2 },
    };

    assert.equal(formatCodexUsageFooter(usage, false, NOW + 2), "Codex · 5h 20% (reset due) · week 6% (reset due)");
  });

  it("uses a complete additional rate limit when the default limit has no windows", () => {
    const payload = {
      plan_type: "pro",
      rate_limit: null,
      additional_rate_limits: [
        {
          limit_name: "Other models",
          metered_feature: "codex_other",
          rate_limit: {
            primary_window: { used_percent: 11, reset_at: 2_000_000_000 },
            secondary_window: null,
          },
        },
        {
          limit_name: "GPT-5.6",
          metered_feature: "codex_bengalfox",
          rate_limit: {
            primary_window: { used_percent: 68, reset_at: 2_000_000_000 },
            secondary_window: { used_percent: 74, reset_at: 2_000_100_000 },
          },
        },
      ],
    };

    const usage = parseCodexUsage(payload, NOW);

    assert.equal(usage.plan, "pro");
    assert.equal(usage.primary.usedPercent, 68);
    assert.equal(usage.secondary.usedPercent, 74);
  });

  it("prefers a weekly-only default limit over an unused complete additional limit", () => {
    const usage = parseCodexUsage({
      plan_type: "pro",
      rate_limit: {
        primary_window: {
          used_percent: 42,
          limit_window_seconds: 604_800,
          reset_at: NOW / 1000 + 86_400,
        },
        secondary_window: null,
      },
      additional_rate_limits: [
        {
          limit_name: "Unused model pool",
          metered_feature: "codex_other",
          rate_limit: {
            primary_window: {
              used_percent: 0,
              limit_window_seconds: 18_000,
              reset_at: 2_000_000_000,
            },
            secondary_window: {
              used_percent: 0,
              limit_window_seconds: 604_800,
              reset_at: 2_000_100_000,
            },
          },
        },
      ],
    }, NOW);

    assert.equal(usage.primary.usedPercent, undefined);
    assert.equal(usage.secondary.usedPercent, 42);
    assert.equal(formatCodexUsageFooter(usage, false, NOW), "Codex · week 42% (resets in 1d)");
    assert.doesNotMatch(formatCodexUsageDetails(usage, NOW), /^5h:/m);
  });

  it("preserves positional labels when both windows include reversed duration metadata", () => {
    const usage = parseCodexUsage({
      rate_limit: {
        primary_window: {
          used_percent: 10,
          limit_window_seconds: 604_800,
          reset_at: 2_000_000_000,
        },
        secondary_window: {
          used_percent: 20,
          limit_window_seconds: 18_000,
          reset_at: 2_000_100_000,
        },
      },
    }, NOW);

    assert.equal(usage.primary.usedPercent, 10);
    assert.equal(usage.secondary.usedPercent, 20);
  });

  it("anchors reset-after values to the fetch time", () => {
    const payload = usagePayload();
    const { reset_at: _resetAt, ...primaryWindow } = payload.rate_limit.primary_window;

    assert.equal(parseCodexUsage({
      ...payload,
      rate_limit: { ...payload.rate_limit, primary_window: primaryWindow },
    }, NOW).primary.resetAt, NOW + 3_600_000);
  });

  it("rounds finite percentages and rejects malformed or oversized responses", () => {
    assert.equal(
      formatCodexUsageFooter(parseCodexUsage(usagePayload(67.6, 73.5), NOW), false, NOW),
      "Codex · 5h 68% (resets in 1h) · week 74% (resets in 2d)",
    );
    assert.throws(() => parseCodexUsage({ rate_limit: {} }, NOW), /usage windows/i);
    assert.throws(() => parseCodexUsage(usagePayload(Number.NaN, 74), NOW), /used percentage/i);
    assert.throws(() => parseCodexUsage("x".repeat(65_537), NOW), /too large/i);
  });

  it("drops reset timestamps that overflow during conversion", () => {
    const usage = parseCodexUsage({
      rate_limit: {
        primary_window: { used_percent: 10, reset_at: 1e308 },
        secondary_window: { used_percent: 20, reset_after_seconds: 1e308 },
      },
    }, NOW);

    assert.equal(usage.primary.resetAt, undefined);
    assert.equal(usage.secondary.resetAt, undefined);
    assert.equal(formatCodexUsageFooter(usage, false, NOW), "Codex · 5h 10% · week 20%");
    assert.doesNotMatch(formatCodexUsageDetails(usage, NOW), /Infinity/);
  });

  it("formats plan, reset, and freshness details", () => {
    const details = formatCodexUsageDetails(parseCodexUsage(usagePayload(), NOW), NOW + 120_000);

    assert.match(details, /Codex usage · Plus plan/);
    assert.match(details, /5h: 68% used · resets in 58m/);
    assert.match(details, /week: 74% used · resets in 1d 23h/);
    assert.match(details, /Updated 2m ago/);
  });
});

describe("Codex usage request", () => {
  it("uses resolved OAuth auth and the fixed account endpoint safely", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const usage = await fetchCodexUsage({
      getProviderAuth: async () => ({ auth: { apiKey: token() }, source: "OAuth" }),
      fetch: async (input, init) => {
        requests.push({ input: String(input), init });
        return new Response(JSON.stringify(usagePayload()), {
          status: 200,
          headers: { "content-type": "application/json", "content-length": "300" },
        });
      },
      now: () => NOW,
    });

    assert.equal(usage.primary.usedPercent, 68);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.input, CODEX_USAGE_ENDPOINT);
    assert.equal(requests[0]?.init?.method, "GET");
    assert.equal(requests[0]?.init?.redirect, "error");
    const headers = new Headers(requests[0]?.init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${token()}`);
    assert.equal(headers.get("chatgpt-account-id"), "account-123");
  });

  it("bounds OAuth resolution with the same timeout", async () => {
    let fetches = 0;
    const outcome = await Promise.race([
      fetchCodexUsage({
        getProviderAuth: async () => new Promise(() => {}),
        fetch: async () => {
          fetches++;
          return new Response("{}");
        },
        timeoutMs: 5,
        now: () => NOW,
      }).then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : String(error)),
      new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 30)),
    ]);

    assert.match(outcome, /timed out/i);
    assert.equal(fetches, 0);
  });

  it("bounds the request with a timeout", async () => {
    await assert.rejects(
      fetchCodexUsage({
        getProviderAuth: async () => ({ auth: { apiKey: token() }, source: "OAuth" }),
        fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
        timeoutMs: 5,
        now: () => NOW,
      }),
      /timed out|aborted/i,
    );
  });

  it("cancels bodies rejected by the content-length limit", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() { cancelled = true; },
    });

    await assert.rejects(fetchCodexUsage({
      getProviderAuth: async () => ({ auth: { apiKey: token() }, source: "OAuth" }),
      fetch: async () => new Response(body, {
        status: 200,
        headers: { "content-length": String(64 * 1024 + 1) },
      }),
      now: () => NOW,
    }), /too large/);

    assert.equal(cancelled, true);
  });

  it("cancels HTTP error bodies before returning the failure", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() { cancelled = true; },
    });

    await assert.rejects(fetchCodexUsage({
      getProviderAuth: async () => ({ auth: { apiKey: token() }, source: "OAuth" }),
      fetch: async () => new Response(body, { status: 503 }),
      now: () => NOW,
    }), /HTTP 503/);

    assert.equal(cancelled, true);
  });

  it("rejects non-OAuth auth, invalid tokens, large bodies, and provider failures without secrets", async () => {
    await assert.rejects(
      fetchCodexUsage({
        getProviderAuth: async () => ({ auth: { apiKey: token() }, source: "OPENAI_API_KEY" }),
        fetch: async () => new Response("{}"),
        now: () => NOW,
      }),
      /OAuth/i,
    );
    await assert.rejects(
      fetchCodexUsage({
        getProviderAuth: async () => ({ auth: { apiKey: "secret-token" }, source: "OAuth" }),
        fetch: async () => new Response("{}"),
        now: () => NOW,
      }),
      (error: unknown) => error instanceof Error && /account id/i.test(error.message) && !error.message.includes("secret-token"),
    );
    await assert.rejects(
      fetchCodexUsage({
        getProviderAuth: async () => ({ auth: { apiKey: token() }, source: "OAuth" }),
        fetch: async () => new Response("x".repeat(65_537), { status: 200 }),
        now: () => NOW,
      }),
      /too large/i,
    );
    await assert.rejects(
      fetchCodexUsage({
        getProviderAuth: async () => ({ auth: { apiKey: token() }, source: "OAuth" }),
        fetch: async () => new Response("private upstream failure", { status: 503 }),
        now: () => NOW,
      }),
      (error: unknown) => error instanceof Error && /503/.test(error.message) && !error.message.includes("private upstream failure"),
    );
  });
});
