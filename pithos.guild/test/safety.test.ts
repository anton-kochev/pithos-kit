import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planModeState } from "../src/safety";

describe("Plan mode state characterization", () => {
  it("is inactive when no Plan state entry exists", () => {
    assert.equal(planModeState([]), "inactive");
    assert.equal(planModeState([null, { type: "custom", customType: "other-state", data: { active: true } }]), "inactive");
  });

  it("recognizes an explicit inactive state", () => {
    assert.equal(
      planModeState([{ type: "custom", customType: "plan-theme-state", data: { active: false } }]),
      "inactive",
    );
  });

  it("recognizes an explicit active state", () => {
    assert.equal(
      planModeState([{ type: "custom", customType: "plan-theme-state", data: { active: true } }]),
      "active",
    );
  });

  it("uses the latest matching Plan state entry", () => {
    assert.equal(planModeState([
      { type: "custom", customType: "plan-theme-state", data: { active: true } },
      { type: "custom", customType: "plan-theme-state", data: { active: false } },
    ]), "inactive");
    assert.equal(planModeState([
      { type: "custom", customType: "plan-theme-state", data: { active: false } },
      { type: "custom", customType: "other-state", data: { active: false } },
      { type: "custom", customType: "plan-theme-state", data: { active: true } },
      { type: "custom", customType: "other-state", data: { active: false } },
    ]), "active");
  });

  it("treats a latest malformed matching entry as indeterminate", () => {
    for (const data of [undefined, null, {}, { active: "true" }]) {
      assert.equal(planModeState([
        { type: "custom", customType: "plan-theme-state", data: { active: false } },
        { type: "custom", customType: "plan-theme-state", data },
      ]), "indeterminate");
    }
  });
});
