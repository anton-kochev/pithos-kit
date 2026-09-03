import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPithosLogger, usageMetadata } from "../src/logging.ts";

async function eventuallyRead(path: string): Promise<string> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			return await readFile(path, "utf8");
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	return readFile(path, "utf8");
}

test("logger is disabled unless level and destination are configured", async () => {
	const logger = createPithosLogger("@pithos-kit/web", { PITHOS_LOG_LEVEL: "debug" });
	assert.equal(logger.enabled, false);
	assert.equal(logger.file, undefined);
});

test("logger writes bounded redacted JSONL records", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pithos-log-"));
	const logger = createPithosLogger("@pithos-kit/web", {
		PITHOS_LOG_LEVEL: "debug",
		PITHOS_LOG_DIR: dir,
	});

	logger.info("example", {
		apiKey: "secret",
		query: "x".repeat(700),
		usage: usageMetadata({ input: 10, output: 5, cacheRead: 2, cost: 0.01 }),
	});

	const content = await eventuallyRead(join(dir, "pithos-web.jsonl"));
	const record = JSON.parse(content.trim());
	assert.equal(record.package, "@pithos-kit/web");
	assert.equal(record.level, "info");
	assert.equal(record.event, "example");
	assert.equal(record.metadata.apiKey, "[redacted]");
	assert.match(record.metadata.query, /more chars\]$/u);
	assert.deepEqual(record.metadata.usage, {
		inputTokens: 10,
		outputTokens: 5,
		cacheReadTokens: 2,
		totalTokens: 17,
		costUsd: 0.01,
	});
});

test("logger filters by level", async () => {
	const file = join(await mkdtemp(join(tmpdir(), "pithos-log-")), "combined.jsonl");
	const logger = createPithosLogger("@pithos-kit/web", {
		PITHOS_LOG_LEVEL: "warn",
		PITHOS_LOG_FILE: file,
	});

	logger.info("ignored");
	logger.warn("written");

	const content = await eventuallyRead(file);
	assert.equal(content.trim().split("\n").length, 1);
	assert.equal(JSON.parse(content).event, "written");
});
