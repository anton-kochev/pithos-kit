import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTranslateCommand, TRANSLATE_HELP } from "../src/command-help.ts";

describe("translate command", () => {
  it("parses manual translation and flat input/output controls", () => {
    assert.deepEqual(parseTranslateCommand(""), { type: "manual" });
    for (const direction of ["input", "output"] as const) {
      for (const action of ["on", "off", "status", "config"] as const) {
        assert.deepEqual(parseTranslateCommand(`${direction}-${action}`), { type: "control", direction, action });
      }
    }
    assert.deepEqual(parseTranslateCommand("--help"), { type: "help" });
    assert.deepEqual(parseTranslateCommand("-h"), { type: "help" });
    assert.match(TRANSLATE_HELP, /Usage: \/translate \[input-\{on,off,status,config\}\|output-\{on,off,status,config\}\|--help\]/);
    assert.match(TRANSLATE_HELP, /without an argument.*manual translation card/is);
    assert.match(TRANSLATE_HELP, /input-on.*prompts.*English/is);
    assert.match(TRANSLATE_HELP, /output-on.*automatic.*assistant/is);
  });

  it("rejects old, nested, and unsupported arguments", () => {
    for (const argument of ["on", "status", "input on", "output config", "later"]) {
      assert.deepEqual(parseTranslateCommand(argument), {
        type: "error",
        message: `Unknown /translate argument: ${argument}`,
      });
    }
    assert.match(TRANSLATE_HELP, /--help, -h/);
  });
});
