import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DoctorTimingTracker,
	formatDoctorProgress,
	formatDoctorTiming,
} from "../src/doctor-diagnostics.ts";

describe("Atlas doctor phase diagnostics", () => {
	it("records fixed phase timings without operation data", async () => {
		let now = 0;
		const tracker = new DoctorTimingTracker(() => now);
		const updates: string[] = [];
		tracker.onUpdate = (snapshot) => updates.push(formatDoctorProgress(snapshot));

		const result = await tracker.measure("registry", async () => {
			now = 17;
			return "registry-result";
		});

		assert.equal(result, "registry-result");
		assert.equal(
			formatDoctorTiming("Doctor timing", tracker.snapshot()),
			"Doctor timing: total=17ms; config=pending; registry=17ms; runtime=pending",
		);
		assert.match(updates.at(-1) ?? "", /waiting for config, runtime · 17ms/);
		assert.doesNotMatch(updates.join("\n"), /registry-result/);
	});

	it("marks failed phases and bounds elapsed values", async () => {
		let now = 0;
		const tracker = new DoctorTimingTracker(() => now);

		await assert.rejects(tracker.measure("config", async () => {
			now = Number.MAX_VALUE;
			throw new Error("sensitive operation detail");
		}), /sensitive operation detail/);

		const output = formatDoctorTiming("Doctor timing", tracker.snapshot());
		assert.match(output, /^Doctor timing: total=9007199254740991ms; config=failed 9007199254740991ms;/);
		assert.doesNotMatch(output, /sensitive operation detail/);
	});
});
