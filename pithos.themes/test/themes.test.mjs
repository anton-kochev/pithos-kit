import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const root = resolve(import.meta.dirname, "..");
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const manifest = readJson("package.json");
const themeFiles = ["auric-dark.json", "auric-light.json"];

const requiredColors = [
	"accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim",
	"text", "thinkingText", "selectedBg", "scrollbarThumb", "userMessageBg", "userMessageText",
	"customMessageBg", "customMessageText", "customMessageLabel", "toolPendingBg", "toolSuccessBg",
	"toolErrorBg", "toolTitle", "toolOutput", "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock",
	"mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved",
	"toolDiffContext", "syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString",
	"syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation", "thinkingOff", "thinkingMinimal",
	"thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax", "bashMode",
].sort();

function resolveColor(theme, value, seen = new Set()) {
	if (typeof value === "number" || value === "" || value.startsWith("#")) return value;
	assert.equal(seen.has(value), false, `circular variable reference: ${value}`);
	assert.ok(Object.hasOwn(theme.vars ?? {}, value), `unknown variable reference: ${value}`);
	seen.add(value);
	return resolveColor(theme, theme.vars[value], seen);
}

function luminance(hex) {
	return [1, 3, 5]
		.map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
		.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
		.reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrast(theme, foreground, background) {
	const values = [foreground, background].map((value) => luminance(resolveColor(theme, value))).sort((a, b) => b - a);
	return (values[0] + 0.05) / (values[1] + 0.05);
}

function rgbTo256(hex) {
	const values = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
	const cube = [0, 95, 135, 175, 215, 255];
	const closest = (value) => cube.reduce((best, candidate, index) =>
		Math.abs(candidate - value) < Math.abs(cube[best] - value) ? index : best, 0);
	const [red, green, blue] = values.map(closest);
	return 16 + 36 * red + 6 * green + blue;
}

describe("@pithos-kit/themes", () => {
	it("publishes a resource-only package containing both Auric themes", () => {
		assert.equal(manifest.name, "@pithos-kit/themes");
		assert.equal(manifest.version, "0.1.0");
		assert.equal(manifest.pithosKit.minimumPi, ">=1.0.0");
		assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], ">=1.0.0");
		assert.deepEqual(manifest.pi, { themes: ["./themes"] });
		assert.deepEqual(manifest.pithosKit.commands, []);
		assert.deepEqual(manifest.pithosKit.themes.map(({ name }) => name), ["auric-dark", "auric-light"]);
		assert.ok(manifest.files.includes("themes"));
	});

	for (const file of themeFiles) {
		it(`${file} defines the complete Pi theme contract`, () => {
			const theme = readJson(`themes/${file}`);
			assert.equal(theme.name, file.replace(/\.json$/u, ""));
			assert.deepEqual(Object.keys(theme.colors).sort(), requiredColors);

			for (const [name, value] of Object.entries({ ...theme.colors, ...theme.export })) {
				const resolved = resolveColor(theme, value);
				assert.equal(
					typeof resolved === "number" || resolved === "" || /^#[0-9a-f]{6}$/iu.test(resolved),
					true,
					`invalid color ${name}: ${resolved}`,
				);
			}
		});
	}

	it("keeps informative text accessible on every message surface", () => {
		for (const file of themeFiles) {
			const theme = readJson(`themes/${file}`);
			const colors = theme.colors;
			for (const [label, foreground, background] of [
				["user text", colors.userMessageText, colors.userMessageBg],
				["custom text", colors.customMessageText, colors.customMessageBg],
				["pending output", colors.toolOutput, colors.toolPendingBg],
				["success output", colors.toolOutput, colors.toolSuccessBg],
				["error output", colors.toolOutput, colors.toolErrorBg],
			]) {
				assert.ok(contrast(theme, foreground, background) >= 4.5, `${theme.name} ${label} must meet WCAG AA`);
			}
		}
	});

	it("preserves distinct sand surfaces in Pi's 256-color fallback", () => {
		const theme = readJson("themes/auric-light.json");
		assert.equal(rgbTo256(resolveColor(theme, theme.colors.userMessageBg)), 187);
		assert.equal(rgbTo256(resolveColor(theme, theme.colors.toolSuccessBg)), 186);
	});
});
