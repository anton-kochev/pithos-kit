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
    assert.equal(manifest.version, "1.1.0");
    assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], ">=0.84.0");
    assert.equal(manifest.pithosKit.minimumPi, ">=0.84.0");
    assert.deepEqual(manifest.pi.extensions, ["./extensions"]);
    assert.deepEqual(manifest.pithosKit.configuration, [{
      kind: "file",
      key: ".pi/translate.json",
      summary: "Project-scoped translation language, model, mode, and optional request timeout.",
    }]);
    assert.ok(manifest.files.includes("src"));
    assert.equal(typeof extension.default, "function");

    assert.match(readme, /\/translate (?:on|off|status|config)/);
    assert.match(readme, /user.*project.*temporary/is);
    assert.match(readme, /display-only/i);
    assert.match(readme, /Translated ·.*target language/is);
    assert.match(readme, /footer status.*language.*model/is);
    assert.doesNotMatch(readme, /Translating….*placeholder/is);
    assert.match(readme, /no fallback/i);
    assert.match(readme, /timeoutMs.*60000/is);
    assert.match(readme, /openai\/\.\.\..*API-key.*openai-codex\/\.\.\..*subscription/is);
    assert.match(readme, /code.*link destination/is);
    assert.match(readme, /tool calls/i);
    assert.match(readme, /~\/\.pi\/agent\/translate\.json/);
    assert.match(readme, /<cwd>\/\.pi\/translate\.json/);
    assert.doesNotMatch(readme, /pithos\.translate\.json/);
    assert.match(readme, /Mermaid.*original/is);
    assert.match(readme, /precede.*display-transforming/is);
    assert.match(readme, /does not enforce English/i);
    assert.match(readme, /does not modify Pi(?:'s)? prompts or model context/i);
    assert.match(readme, /English-default policy.*user or project instructions/is);
  });
});
