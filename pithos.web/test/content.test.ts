import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractWebContent } from "../src/content.ts";
import type { PublicResource } from "../src/http-client.ts";

function resource(overrides: Partial<PublicResource>): PublicResource {
	return {
		finalUrl: "https://example.com/docs/page",
		status: 200,
		contentType: "text/html; charset=utf-8",
		body: "",
		bytes: 0,
		redirects: 0,
		...overrides,
	};
}

describe("web page extraction", () => {
	it("turns static HTML into readable text with useful absolute links and no executable content", () => {
		const result = extractWebContent(resource({
			body: `<!doctype html>
				<html><head><title>Pi &amp; tools</title><style>.hidden { color: red }</style></head>
				<body><main><h1>Extensions</h1><p>Read the <a href="/guide">guide</a>.</p>
				<script>ignorePrompt('do evil')</script><noscript>fallback noise</noscript></main></body></html>`,
		}));

		assert.equal(result.title, "Pi & tools");
		assert.match(result.text, /Extensions/);
		assert.match(result.text, /guide \[https:\/\/example\.com\/guide\]/);
		assert.doesNotMatch(result.text, /color: red|ignorePrompt|fallback noise/);
		assert.equal(result.truncated, false);
	});

	it("preserves declared plain and Markdown text while removing terminal controls", () => {
		const result = extractWebContent(resource({
			contentType: "text/markdown; charset=utf-8",
			body: "# Heading\n\nKeep `code`\u001b[31m and text.\u0000",
		}));

		assert.equal(result.mediaType, "text/markdown");
		assert.equal(result.text, "# Heading\n\nKeep `code` and text.");
	});

	it("renders Unicode direction controls visibly instead of reordering terminal text", () => {
		const result = extractWebContent(resource({
			contentType: "text/plain",
			body: "safe\u202eevil and left\u2066right\u2069",
		}));

		assert.equal(result.text, "safe[U+202E]evil and left[U+2066]right[U+2069]");
	});

	it("rejects missing, binary, and empty content", () => {
		assert.throws(() => extractWebContent(resource({ contentType: "" })), /declared textual content type/i);
		assert.throws(() => extractWebContent(resource({ contentType: "application/pdf", body: "%PDF" })), /does not support/i);
		assert.throws(() => extractWebContent(resource({ contentType: "text/html", body: "<script>only code</script>" })), /no readable text/i);
	});

	it("bounds link expansion and tree traversal before final output truncation", () => {
		const longBase = `https://example.com/${"b".repeat(3_000)}/page`;
		const links = Array.from({ length: 500 }, (_, index) => `<a href="item-${index}">item ${index}</a>`).join("");
		const result = extractWebContent(resource({
			finalUrl: longBase,
			body: `<html><body><main>${links}</main></body></html>`,
		}));

		assert.ok(result.totalBytes < 700_000, `intermediate text was ${result.totalBytes} bytes`);
		assert.ok(result.outputBytes <= 48 * 1024);
		assert.equal(result.truncated, true);
	});

	it("stops traversal of deeply nested attacker-controlled HTML", () => {
		const body = `${"<div>".repeat(5_000)}deep secret${"</div>".repeat(5_000)}`;
		const result = extractWebContent(resource({ body }));

		assert.match(result.text, /content omitted/i);
		assert.doesNotMatch(result.text, /deep secret/i);
		assert.equal(result.truncated, true);
		assert.ok(result.omissions.some((reason) => /traversal/i.test(reason)));
	});

	it("marks a single overlong link destination as omitted", () => {
		const result = extractWebContent(resource({
			body: `<html><body><a href="https://example.com/${"x".repeat(3_000)}">long link</a></body></html>`,
		}));

		assert.equal(result.truncated, true);
		assert.ok(result.omissions.some((reason) => /link destination/i.test(reason)));
	});

	it("reports title-budget omissions even when the body fits", () => {
		const result = extractWebContent(resource({
			body: `<html><head><title>${"title".repeat(2_000)}</title></head><body>short body</body></html>`,
		}));

		assert.equal(result.truncated, true);
		assert.ok(result.omissions.some((reason) => /title/i.test(reason)));
		assert.ok(Buffer.byteLength(result.title ?? "", "utf8") <= 1_024);
	});

	it("reports title traversal omissions below the title byte and input limits", () => {
		const nestedTitle = `${"<span>".repeat(32)}deep title${"</span>".repeat(32)}`;
		const result = extractWebContent(resource({
			body: `<html><head><title>${nestedTitle}</title></head><body>short body</body></html>`,
		}));

		assert.equal(result.truncated, true);
		assert.ok(result.omissions.some((reason) => /title/i.test(reason)));
	});

	it("retains structured omission reasons when the visible payload is also truncated", () => {
		const result = extractWebContent(resource({
			body: `<html><body><a href="https://example.com/${"x".repeat(3_000)}">long link</a><p>${"body ".repeat(20_000)}</p></body></html>`,
		}));

		assert.equal(result.truncated, true);
		assert.ok(result.omissions.some((reason) => /link destination/i.test(reason)));
		assert.ok(result.outputBytes <= 48 * 1024);
	});

	it("truncates by lines and UTF-8 bytes without splitting a character", () => {
		const lineLimited = extractWebContent(resource({
			contentType: "text/plain",
			body: "one\ntwo\nthree",
		}), { maxOutputLines: 2, maxOutputBytes: 100 });
		assert.deepEqual(
			{ text: lineLimited.text, truncated: lineLimited.truncated, totalLines: lineLimited.totalLines, outputLines: lineLimited.outputLines },
			{ text: "one\ntwo", truncated: true, totalLines: 3, outputLines: 2 },
		);

		const byteLimited = extractWebContent(resource({
			contentType: "text/plain",
			body: "ééé",
		}), { maxOutputLines: 10, maxOutputBytes: 5 });
		assert.equal(byteLimited.text, "éé");
		assert.equal(byteLimited.outputBytes, 4);
		assert.equal(byteLimited.totalBytes, 6);
		assert.equal(byteLimited.truncated, true);
	});
});
