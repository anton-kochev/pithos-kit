import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_CHECK_INTERVAL_MS, DEFAULT_REFRESH_INTERVAL_MS, configPath, loadTelosConfig, parseTelosConfig } from "../src/config";

it("parses only strict JSON config objects with bounded integer intervals", () => {
	assert.equal(DEFAULT_REFRESH_INTERVAL_MS, 1000);
	assert.equal(CONFIG_CHECK_INTERVAL_MS, 1000);
	assert.deepEqual(parseTelosConfig("{}"), { refreshIntervalMs: 1000, visibleTaskCount: 10 });
	for (const refreshIntervalMs of [250, 1000, 2147483647]) {
		assert.deepEqual(parseTelosConfig(JSON.stringify({ refreshIntervalMs })), { refreshIntervalMs, visibleTaskCount: 10 });
	}
	for (const text of ["null", "[]", "1", "true", '"secret"', '{"secret":1}', '{"refreshIntervalMs":null}', '{"refreshIntervalMs":"1000"}', '{"refreshIntervalMs":true}', '{"refreshIntervalMs":249}', '{"refreshIntervalMs":250.5}', '{"refreshIntervalMs":2147483648}', '{"refreshIntervalMs":1e999}', '{"refreshIntervalMs":1000,}', '/* secret */ {}', '{secret']) {
		assert.throws(() => parseTelosConfig(text), (error: Error) => {
			assert.ok(error.message.length < 160);
			assert.ok(!error.message.includes("secret"));
			return true;
		}, text);
	}
});

it("accepts a positive safe-integer visible task count with an independent default of ten", () => {
	assert.equal(parseTelosConfig("{}").visibleTaskCount, 10);
	assert.deepEqual(parseTelosConfig('{"visibleTaskCount":3}'), { refreshIntervalMs: 1000, visibleTaskCount: 3 });
	for (const visibleTaskCount of [1, 10, 25, Number.MAX_SAFE_INTEGER]) {
		assert.equal(parseTelosConfig(JSON.stringify({ refreshIntervalMs: 250, visibleTaskCount })).visibleTaskCount, visibleTaskCount);
	}
	for (const value of [0, -1, 1.5, null, "10", true, [], {}, Number.MAX_SAFE_INTEGER + 1]) {
		assert.throws(() => parseTelosConfig(JSON.stringify({ visibleTaskCount: value })), /visibleTaskCount/);
	}
});

it("loads config without writing, defaults only for ENOENT, and keeps errors safe", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "telos-config-"));
	try {
		assert.equal(configPath(cwd), join(cwd, ".pi", "telos.json"));
		assert.deepEqual(await loadTelosConfig(cwd), { refreshIntervalMs: 1000, visibleTaskCount: 10 });
		assert.deepEqual(await readdir(cwd), []);
		await mkdir(join(cwd, ".pi"));
		const path = configPath(cwd);
		const text = '{"refreshIntervalMs":250}\n';
		await writeFile(path, text);
		assert.deepEqual(await loadTelosConfig(cwd), { refreshIntervalMs: 250, visibleTaskCount: 10 });
		assert.equal(await readFile(path, "utf8"), text);
		await writeFile(path, '{"secret": "private contents"}');
		await assert.rejects(loadTelosConfig(cwd), (error: Error) => !/secret|private contents/.test(error.message));
		assert.equal(await readFile(path, "utf8"), '{"secret": "private contents"}');
		assert.deepEqual(await readdir(join(cwd, ".pi")), ["telos.json"]);
		await rm(path);
		assert.deepEqual(await loadTelosConfig(cwd), { refreshIntervalMs: 1000, visibleTaskCount: 10 });
		await mkdir(path);
		await assert.rejects(loadTelosConfig(cwd), /Unable to read Telos config/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
