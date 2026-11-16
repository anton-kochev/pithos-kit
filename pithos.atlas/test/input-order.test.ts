import assert from "node:assert/strict";
import { it } from "node:test";
import { diagnoseInputOrder } from "../src/input-order.ts";
import type { RuntimeCommandInfo } from "../src/runtime.ts";

function command(name: string, local = false): RuntimeCommandInfo {
	return { name, source: "extension", sourceInfo: {
		path: `/packages/pithos.${name}/extensions/index.ts`,
		source: local ? `/packages/pithos.${name}` : `npm:@pithos-kit/${name}@1.0.0`,
		baseDir: `/packages/pithos.${name}`,
	} };
}

it("diagnoses chained input order from unsorted npm and local command provenance without a Pi version", () => {
	for (const local of [false, true]) {
		const squiggle = command("squiggle", local);
		const translate = command("translate", local);
		if (local) translate.sourceInfo.source = "./pithos.translate";
		const forward = diagnoseInputOrder([squiggle, translate]);
		assert.equal(forward.status, "ok");
		assert.match(forward.message, /inferred from observed command order/);
		const reversed = diagnoseInputOrder([translate, squiggle]);
		assert.equal(reversed.status, "warning");
		assert.match(reversed.message, /observed command order/);
		assert.match(reversed.message, /Squiggle before Translate/);
		assert.match(reversed.message, /settings.json/);
		for (const commands of [[], [squiggle], [translate]]) {
			assert.equal(diagnoseInputOrder(commands).status, "not-applicable");
		}
		assert.equal(diagnoseInputOrder([squiggle, { ...translate, sourceInfo: { path: "/custom/translate.ts", source: "auto" } }]).status, "unknown");
		assert.equal(diagnoseInputOrder([squiggle, translate, squiggle]).status, "unknown");
		const directTranslate = { ...translate, name: "translate:1", sourceInfo: { path: "/custom/translate.ts", source: "auto" } };
		assert.equal(diagnoseInputOrder([directTranslate, squiggle, { ...translate, name: "translate:2" }]).status, "unknown");
		const directSquiggle = { ...squiggle, name: "squiggle:2", sourceInfo: { path: "/custom/squiggle.ts", source: "auto" } };
		assert.equal(diagnoseInputOrder([{ ...squiggle, name: "squiggle:1" }, translate, directSquiggle]).status, "unknown");
		assert.equal(diagnoseInputOrder([{ ...translate, source: "prompt" }, squiggle]).status, "not-applicable");
	}
});
