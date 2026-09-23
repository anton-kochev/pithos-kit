import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitGuildHandover, planModeState } from "../src/safety";

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

describe("Guild handover admission", () => {
  it("captures immutable trusted admission data while Plan mode is inactive", () => {
    let trustCaptures = 0;
    const admission = admitGuildHandover({
      sessionManager: {
        getBranch: () => [{ type: "custom", customType: "plan-theme-state", data: { active: false } }],
      },
      isProjectTrusted: () => {
        trustCaptures += 1;
        return true;
      },
    });

    assert.deepEqual(admission, { projectTrusted: true });
    assert.equal(Object.isFrozen(admission), true);
    assert.equal(trustCaptures, 1);
  });

  it("captures immutable untrusted admission data while Plan mode is inactive", () => {
    const admission = admitGuildHandover({
      sessionManager: { getBranch: () => [] },
      isProjectTrusted: () => false,
    });

    assert.deepEqual(admission, { projectTrusted: false });
    assert.equal(Object.isFrozen(admission), true);
  });

  it("uses the latest matching Plan state when admitting a handover", () => {
    const admission = admitGuildHandover({
      sessionManager: {
        getBranch: () => [
          { type: "custom", customType: "plan-theme-state", data: { active: true } },
          { type: "custom", customType: "other-state", data: { active: true } },
          { type: "custom", customType: "plan-theme-state", data: { active: false } },
          { type: "custom", customType: "other-state", data: { active: true } },
        ],
      },
      isProjectTrusted: () => true,
    });

    assert.deepEqual(admission, { projectTrusted: true });
  });

  it("rejects active Plan mode before capturing project trust", () => {
    let trustCaptures = 0;
    const context = {
      sessionManager: {
        getBranch: () => [
          { type: "custom", customType: "plan-theme-state", data: { active: false } },
          { type: "custom", customType: "other-state", data: { active: false } },
          { type: "custom", customType: "plan-theme-state", data: { active: true } },
        ],
      },
      isProjectTrusted: () => {
        trustCaptures += 1;
        return true;
      },
    };

    assert.throws(
      () => admitGuildHandover(context),
      /Guild handover.*Plan mode.*active/i,
    );
    assert.equal(trustCaptures, 0);
  });

  it("rejects an indeterminate latest Plan state before capturing project trust", () => {
    let trustCaptures = 0;
    const context = {
      sessionManager: {
        getBranch: () => [
          { type: "custom", customType: "plan-theme-state", data: { active: false } },
          { type: "custom", customType: "plan-theme-state", data: {} },
        ],
      },
      isProjectTrusted: () => {
        trustCaptures += 1;
        return false;
      },
    };

    assert.throws(
      () => admitGuildHandover(context),
      /Guild handover.*Plan mode.*indeterminate/i,
    );
    assert.equal(trustCaptures, 0);
  });
});
