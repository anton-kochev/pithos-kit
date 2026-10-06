import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { buildCatalog, validatePackageManifest } from "../src/catalog.ts";

const validManifest = {
	name: "@pithos-kit/example",
	version: "1.2.3",
	description: "An example package.",
	pi: { extensions: ["./extensions"] },
	pithosKit: {
		displayName: "Example",
		summary: "An example package.",
		minimumPi: ">=0.83.0",
		commands: [{ name: "example", usage: "/example [--help]", summary: "Run the example." }],
		tools: [],
		prompts: [],
		skills: [],
		themes: [],
		agents: [],
		configuration: [],
	},
};

describe("Atlas catalog manifest validation", () => {
	it("accepts and normalizes a self-describing pithos-kit manifest", () => {
		const result = validatePackageManifest(validManifest);

		assert.equal(result.name, "@pithos-kit/example");
		assert.equal(result.version, "1.2.3");
		assert.equal(result.pithosKit.minimumPi, ">=0.83.0");
		assert.deepEqual(result.pithosKit.commands.map(({ name }) => name), ["example"]);
	});

	it("builds a deterministic name-sorted catalog", () => {
		const second = { ...validManifest, name: "@pithos-kit/zebra" };
		const first = { ...validManifest, name: "@pithos-kit/alpha" };

		const catalog = buildCatalog([second, first]);

		assert.equal(catalog.schemaVersion, 1);
		assert.deepEqual(catalog.packages.map(({ name }) => name), ["@pithos-kit/alpha", "@pithos-kit/zebra"]);
	});

	it("keeps the bundled snapshot synchronized with every local package manifest", () => {
		const root = resolve(import.meta.dirname, "..", "..");
		const directories = [
			"pithos.squiggle",
			"pithos.echo",
			"pithos.answer",
			"pithos.telos",
			"pithos.aegis",
			"pithos.guild",
			"pithos.context-bar",
			"pithos.plan",
			"pithos.themes",
			"pithos.translate",
			"pithos.web",
			"pithos.clio",
			"pithos.atlas",
		];
		const manifests = directories.map((directory) => JSON.parse(readFileSync(resolve(root, directory, "package.json"), "utf8")));
		const bundled = JSON.parse(readFileSync(resolve(root, "pithos.atlas", "src", "generated", "catalog.json"), "utf8"));

		assert.deepEqual(bundled, buildCatalog(manifests));
	});

	it("rejects invalid or duplicate package names", () => {
		assert.throws(
			() => validatePackageManifest({ ...validManifest, name: "@pithos-kit/../example" }),
			/must use a valid/,
		);
		assert.throws(
			() => buildCatalog([validManifest, validManifest]),
			/duplicate package/,
		);
	});

	it("rejects control characters and duplicate capability names", () => {
		assert.throws(
			() => validatePackageManifest({ ...validManifest, description: "unsafe\u001b[31m" }),
			/control characters/,
		);
		assert.throws(
			() => validatePackageManifest({
				...validManifest,
				pithosKit: {
					...validManifest.pithosKit,
					commands: [validManifest.pithosKit.commands[0], validManifest.pithosKit.commands[0]],
				},
			}),
			/duplicate capability/,
		);
	});
});
