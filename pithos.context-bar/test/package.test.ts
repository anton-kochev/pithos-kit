import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

describe("context-bar package metadata", () => {
  it("loads the published extension entry point", async () => {
    const extension = await import("../extensions/index.ts");
    assert.equal(typeof extension.default, "function");
  });

  it("publishes the standalone Pi extension under the expected identity", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
    );

    assert.equal(packageJson.name, "@pithos-kit/context-bar");
    assert.equal(packageJson.repository.directory, "pithos.context-bar");
    assert.deepEqual(packageJson.pi.extensions, ["./extensions"]);
    assert.equal(packageJson.peerDependencies["@earendil-works/pi-coding-agent"], ">=1.0.0");
    assert.equal(packageJson.pithosKit.minimumPi, ">=1.0.0");
    assert.equal(packageJson.devDependencies["@earendil-works/pi-tui"], "^0.84.1");
    assert.equal(packageJson.scripts.audit, "npm audit --audit-level=moderate");
    assert.ok(packageJson.files.includes("src"));
    assert.ok(packageJson.files.includes("extensions"));
    assert.match(packageJson.description, /context-window/);
  });

  it("is wired into local development, repository docs, and trusted publishing", () => {
    const root = resolve(import.meta.dirname, "../..");
    const readme = readFileSync(resolve(root, "README.md"), "utf8");
    const workflow = readFileSync(
      resolve(root, ".github/workflows/publish-pithos.context-bar.yml"),
      "utf8",
    );

    assert.match(readme, /@pithos-kit\/context-bar/);
    assert.match(workflow, /tags: \["pithos-kit\.context-bar-v\*"\]/);
    assert.match(workflow, /working-directory: pithos\.context-bar/);
    assert.match(workflow, /npm ci/);
    assert.match(workflow, /npm test/);
    assert.match(workflow, /npm run audit/);
    assert.match(workflow, /npm run typecheck/);
    assert.match(workflow, /npm pack --dry-run/);
    assert.match(workflow, /npm publish --provenance --access public/);
  });
});
