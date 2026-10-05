import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const root = resolve(import.meta.dirname, "..");
const repositoryUrl = "git+https://github.com/anton-kochev/pithos-kit.git";
const packages = [
  { directory: "pithos.squiggle", shortName: "squiggle", version: "0.6.0", minimumPi: ">=0.83.0" },
  { directory: "pithos.echo", shortName: "echo", version: "0.5.0", minimumPi: ">=0.83.0" },
  { directory: "pithos.answer", shortName: "answer", version: "0.3.0", minimumPi: ">=0.83.0" },
  { directory: "pithos.telos", shortName: "telos", version: "0.3.0", minimumPi: ">=0.83.0" },
  { directory: "pithos.aegis", shortName: "aegis", version: "0.2.0", minimumPi: ">=0.83.0" },
  { directory: "pithos.guild", shortName: "guild", version: "0.6.0", minimumPi: ">=0.87.0" },
  { directory: "pithos.context-bar", shortName: "context-bar", version: "0.2.0", minimumPi: ">=0.84.1" },
  { directory: "pithos.plan", shortName: "plan", version: "0.5.1", minimumPi: ">=0.83.0" },
  { directory: "pithos.themes", shortName: "themes", version: "0.1.0", minimumPi: ">=0.84.1" },
  { directory: "pithos.translate", shortName: "translate", version: "2.0.0", minimumPi: ">=0.84.0" },
  { directory: "pithos.web", shortName: "web", version: "0.2.0", minimumPi: ">=0.83.0" },
  { directory: "pithos.atlas", shortName: "atlas", version: "0.8.1", minimumPi: ">=0.83.0" },
];

const capabilityKinds = ["commands", "tools", "prompts", "skills", "themes", "agents"];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:json|md|mjs|ts|ya?ml)$/u.test(entry.name) ? [path] : [];
  });
}

describe("pithos-kit package identities", () => {
  it("uses the confirmed @pithos-kit short-name identity map consistently", () => {
    const rootPackage = readJson(resolve(root, "package.json"));
    assert.equal(rootPackage.name, "pithos-kit");
    assert.equal(rootPackage.repository.url, repositoryUrl);

    const readme = readFileSync(resolve(root, "README.md"), "utf8");
    assert.match(readme, /^# pithos-kit$/m);

    const manifests = [];
    for (const { directory, shortName, version, minimumPi } of packages) {
      assert.equal(existsSync(resolve(root, directory)), true, `missing ${directory}/`);

      const manifest = readJson(resolve(root, directory, "package.json"));
      manifests.push(manifest);
      assert.equal(manifest.name, `@pithos-kit/${shortName}`);
      assert.equal(manifest.version, version);
      assert.equal(manifest.keywords.includes("pithos"), true);
      assert.equal(manifest.repository.url, repositoryUrl);
      assert.equal(manifest.repository.directory, directory);

      assert.equal(typeof manifest.pithosKit?.displayName, "string");
      assert.equal(typeof manifest.pithosKit?.summary, "string");
      assert.equal(manifest.pithosKit?.minimumPi, minimumPi);
      assert.equal(Array.isArray(manifest.pithosKit?.configuration), true);
      for (const kind of capabilityKinds) {
        assert.equal(Array.isArray(manifest.pithosKit?.[kind]), true, `${manifest.name} must describe ${kind}`);
      }
      assert.equal(
        capabilityKinds.some((kind) => manifest.pithosKit[kind].length > 0),
        true,
        `${manifest.name} must describe at least one capability`,
      );

      const workflowPath = resolve(root, ".github", "workflows", `publish-${directory}.yml`);
      assert.equal(existsSync(workflowPath), true, `missing publish-${directory}.yml`);
      const workflow = readFileSync(workflowPath, "utf8");
      assert.match(workflow, new RegExp(`tags: \\["pithos-kit\\.${shortName.replaceAll("-", "\\-")}-v\\*"\\]`));
      assert.match(workflow, new RegExp(`working-directory: ${directory.replaceAll(".", "\\.")}`));
      assert.match(workflow, /npm test/);
      assert.match(workflow, /npm pack --dry-run/);
      assert.match(workflow, /npm publish --provenance --access public/);
      if (shortName === "guild") {
        assert.match(workflow, /\*-beta\.\*\) npm publish --provenance --access public --tag beta/u);
        assert.match(workflow, /\*-\*\) echo "Unsupported Guild prerelease channel: \$VERSION" >&2; exit 1/u);
      }
      assert.match(readme, new RegExp(`@pithos-kit/${shortName}`));

      const packageReadme = readFileSync(resolve(root, directory, "README.md"), "utf8");
      assert.match(packageReadme, /\.pithos/u, `${manifest.name} must document .pithos`);
      assert.match(packageReadme, new RegExp(`"@pithos-kit/${shortName}": "npm:${version.replaceAll(".", "\\.")}"`));
      if (shortName === "atlas") {
        assert.match(packageReadme, /\/pithos help/u);
        assert.deepEqual(manifest.bin, {
          "pithos-atlas-patch": "./scripts/pi-footer-patch.mjs",
          "pithos-atlas-pi": "./scripts/pi-footer-launcher.mjs",
        });
      }
      else if (manifest.pithosKit.commands.length > 0) {
        assert.match(packageReadme, /--help/u, `${manifest.name} must document package-local help`);
      }
    }

    const generatedCatalog = readJson(resolve(root, "pithos.atlas", "src", "generated", "catalog.json"));
    const expectedCatalog = {
      schemaVersion: 1,
      packages: manifests
        .map(({ name, version, description, pi, pithosKit }) => ({ name, version, description, pi, pithosKit }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    };
    assert.deepEqual(generatedCatalog, expectedCatalog, "generated Atlas catalog must match package manifests");
    assert.equal(existsSync(resolve(root, "scripts", "generate-atlas-catalog.ts")), true);
    assert.match(rootPackage.scripts["catalog:generate"], /generate-atlas-catalog\.ts/u);
  });

  it("updates lock roots and keeps prior npm identities only in the administrative cutover", () => {
    for (const { directory, shortName } of packages) {
      const lockPath = resolve(root, directory, "package-lock.json");
      if (existsSync(lockPath)) {
        const lock = readJson(lockPath);
        assert.equal(lock.name, `@pithos-kit/${shortName}`);
        assert.equal(lock.packages[""].name, `@pithos-kit/${shortName}`);
      }
    }

    const files = [
      resolve(root, "README.md"),
      ...sourceFiles(resolve(root, "test")),
      ...sourceFiles(resolve(root, ".github", "workflows")),
      ...sourceFiles(resolve(root, "scripts")),
      ...packages.flatMap(({ directory }) => sourceFiles(resolve(root, directory))),
    ];
    const previousTag = /pithos\.(?:squiggle|echo|answer|telos|aegis|guild|context-bar|skills)-v/u;
    for (const path of files) {
      const content = readFileSync(path, "utf8");
      assert.doesNotMatch(content, /@anton-kochev\/pithos\./u, `stale npm identity in ${path}`);
      assert.doesNotMatch(content, previousTag, `stale release-tag prefix in ${path}`);
    }
  });
});
