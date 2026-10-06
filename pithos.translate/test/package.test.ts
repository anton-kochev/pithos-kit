import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

describe("translate package", () => {
  it("publishes the expected Pi package identity and documents its guarantees", async () => {
    const root = resolve(import.meta.dirname, "..");
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    const readme = readFileSync(resolve(root, "README.md"), "utf8");
    const extension = await import("../extensions/index.ts");

    assert.equal(manifest.name, "@pithos-kit/translate");
    assert.equal(manifest.version, "2.0.0");
    assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], ">=1.0.0");
    assert.equal(manifest.pithosKit.minimumPi, ">=1.0.0");
    assert.deepEqual(manifest.pi.extensions, ["./extensions"]);
    assert.match(manifest.description, /input.*English.*assistant/i);
    assert.match(manifest.pithosKit.summary, /input.*English.*assistant/i);
    assert.deepEqual(manifest.pithosKit.commands, [{
      name: "translate",
      usage: "/translate [input-on|input-off|input-status|input-config|output-on|output-off|output-status|output-config|--help]",
      summary: "Translate interactive input into English or manage assistant-output translation.",
    }]);
    assert.deepEqual(manifest.pithosKit.configuration, [{
      kind: "file",
      key: ".pi/translate.json",
      summary: "Project-scoped input/output translation models, modes, target language, and optional request timeouts.",
    }]);
    assert.ok(manifest.files.includes("src"));
    assert.equal(typeof extension.default, "function");

    for (const argument of [
      "input-on", "input-off", "input-status", "input-config",
      "output-on", "output-off", "output-status", "output-config",
    ]) {
      assert.match(readme, new RegExp(`/translate ${argument}\\b`));
    }
    assert.doesNotMatch(readme, /`\/translate (?:on|off|status|config)`/);
    assert.match(readme, /user.*project.*temporary/is);
    assert.match(readme, /display-only/i);
    assert.match(readme, /display-only marker[\s\S]*Translated · French/i);
    assert.match(readme, /footer status.*language.*model/is);
    assert.doesNotMatch(readme, /Translating….*placeholder/is);
    assert.match(readme, /no fallback/i);
    assert.match(readme, /"input"[\s\S]*"output"[\s\S]*"mode": "(?:on|off)"/);
    assert.doesNotMatch(readme, /"mode": "(?:manual|automatic)"/);
    assert.match(readme, /timeoutMs.*60000/is);
    assert.match(readme, /openai\/\.\.\..*API-key.*openai-codex\/\.\.\..*subscription/is);
    assert.match(readme, /code.*link destination/is);
    assert.match(readme, /tool calls/i);
    assert.match(readme, /~\/\.pi\/agent\/translate\.json/);
    assert.match(readme, /<cwd>\/\.pi\/translate\.json/);
    assert.doesNotMatch(readme, /pithos\.translate\.json/);
    assert.match(readme, /Mermaid.*original/is);
    assert.match(readme, /precede.*display-transforming/is);
    assert.match(readme, /ordinary idle.*interactive TUI/is);
    assert.match(readme, /before.*skill.*template.*expansion/is);
    assert.match(readme, /extension-originated.*bypass/is);
    assert.match(readme, /RPC.*print.*JSON.*steer.*follow-up.*block/is);
    assert.match(readme, /directive token.*exact/is);
    assert.match(readme, /attachments.*preserv/is);
    assert.match(readme, /fails? closed.*draft.*restor/is);
    assert.match(readme, /original.*not.*persist.*main model context/is);
    assert.match(readme, /transiently.*translation provider/is);
    assert.match(readme, /never record raw inbound text/i);
    assert.match(readme, /main assistant-model response.*usage.*response text/is);
  });
});
