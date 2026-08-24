import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	buildPlanCancellationMessage,
	buildPlanSystemPrompt,
	createPlanFile,
	createPlanFileAtPath,
	generatePlanPath,
	preparePlanMutation,
	resolveAvailablePlanPath,
	resolvePlanCancellation,
} from "../extensions/plan-files.ts";

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-files-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

describe("generatePlanPath", () => {
	it("prefixes the readable task name with its creation timestamp", async () => {
		await withTempDirectory(async (cwd) => {
			const path = await generatePlanPath(
				cwd,
				".pi",
				"Save the plan with a generated name",
				new Date("2026-06-29T23:15:07Z"),
			);

			assert.equal(path, ".pi/plans/2026-06-29-231507-save-the-plan-with-a-generated-name.md");
		});
	});

	it("keeps an unnamed plan readable", async () => {
		await withTempDirectory(async (cwd) => {
			const path = await generatePlanPath(cwd, ".pi", "", new Date("2026-06-29T23:15:07Z"));

			assert.equal(path, ".pi/plans/2026-06-29-231507-plan.md");
		});
	});

	it("advances the readable timestamp instead of adding a numeric suffix on collision", async () => {
		await withTempDirectory(async (cwd) => {
			const plansDirectory = join(cwd, ".pi", "plans");
			await mkdir(plansDirectory, { recursive: true });
			await writeFile(join(plansDirectory, "2026-06-29-231507-improve-auth.md"), "existing plan");

			const path = await generatePlanPath(cwd, ".pi", "Improve auth", new Date("2026-06-29T23:15:07Z"));

			assert.equal(path, ".pi/plans/2026-06-29-231508-improve-auth.md");
		});
	});
});

describe("createPlanFile", () => {
	it("advances the timestamp instead of overwriting a plan created after path generation", async () => {
		await withTempDirectory(async (cwd) => {
			const originalPath = ".pi/plans/2026-06-29-231507-improve-auth.md";
			await mkdir(join(cwd, ".pi", "plans"), { recursive: true });
			await writeFile(join(cwd, originalPath), "existing plan");

			const createdPath = await createPlanFile(cwd, originalPath, "new plan");

			assert.equal(createdPath, ".pi/plans/2026-06-29-231508-improve-auth.md");
			assert.equal(await readFile(join(cwd, originalPath), "utf8"), "existing plan");
			assert.equal(await readFile(join(cwd, createdPath), "utf8"), "new plan");
		});
	});

	it("resolves the destination before approval without creating it", async () => {
		await withTempDirectory(async (cwd) => {
			const originalPath = ".pi/plans/2026-06-29-231507-improve-auth.md";
			await mkdir(join(cwd, ".pi", "plans"), { recursive: true });
			await writeFile(join(cwd, originalPath), "existing plan");

			const availablePath = await resolveAvailablePlanPath(cwd, originalPath);

			assert.equal(availablePath, ".pi/plans/2026-06-29-231508-improve-auth.md");
			await assert.rejects(readFile(join(cwd, availablePath), "utf8"), { code: "ENOENT" });
		});
	});

	it("skips a dangling symlink when resolving the destination", async () => {
		await withTempDirectory(async (cwd) => {
			const originalPath = ".pi/plans/2026-06-29-231507-improve-auth.md";
			await mkdir(join(cwd, ".pi", "plans"), { recursive: true });
			await symlink("missing-plan.md", join(cwd, originalPath));

			const availablePath = await resolveAvailablePlanPath(cwd, originalPath);

			assert.equal(availablePath, ".pi/plans/2026-06-29-231508-improve-auth.md");
		});
	});

	it("publishes only at the exact approved destination", async () => {
		await withTempDirectory(async (cwd) => {
			const approvedPath = ".pi/plans/2026-06-29-231507-improve-auth.md";
			await createPlanFileAtPath(cwd, approvedPath, "approved plan");

			await assert.rejects(createPlanFileAtPath(cwd, approvedPath, "changed plan"), { code: "EEXIST" });
			assert.equal(await readFile(join(cwd, approvedPath), "utf8"), "approved plan");
		});
	});
});

describe("resolvePlanCancellation", () => {
	it("recognizes a legacy cancellation when its generated plan was never saved", async () => {
		await withTempDirectory(async (cwd) => {
			const cancelled = await resolvePlanCancellation(cwd, [
				{ active: true, planPath: ".pi/plans/example.md" },
				{ active: false },
			]);

			assert.equal(cancelled, true);
		});
	});
});

describe("buildPlanCancellationMessage", () => {
	it("makes the hidden command state explicit to the next model turn", () => {
		const message = buildPlanCancellationMessage();

		assert.match(message, /^\[PLAN MODE CANCELLED\]/);
		assert.match(message, /Plan mode is now inactive/);
		assert.match(message, /Ignore any earlier Plan Mode workflow instructions/);
	});
});

describe("buildPlanSystemPrompt", () => {
	it("overrides stale planning instructions after cancellation", () => {
		const prompt = buildPlanSystemPrompt("base prompt", {
			active: false,
			cancelled: true,
		});

		assert.match(prompt ?? "", /^base prompt/);
		assert.match(prompt ?? "", /Plan mode is inactive because the user cancelled it/);
		assert.match(prompt ?? "", /Ignore any earlier Plan Mode workflow instructions/);
	});

	it("reinforces enforced read-only behavior on every active Plan turn", () => {
		const prompt = buildPlanSystemPrompt("base prompt", {
			active: true,
			cancelled: false,
			planPath: ".pi/plans/example.md",
		});

		assert.match(prompt ?? "", /read-only Plan mode is enforced/i);
		assert.match(prompt ?? "", /read, grep, find, and ls/i);
		assert.match(prompt ?? "", /web_search and web_fetch.*when available/i);
		assert.match(prompt ?? "", /other custom tools.*blocked/i);
		assert.match(prompt ?? "", /optionally preview the exact Markdown draft/i);
		assert.match(prompt ?? "", /create.*without preview/i);
		assert.match(prompt ?? "", /Continue planning.*safe default/i);
	});

	it("supplies the generated plan path while planning remains active", () => {
		const prompt = buildPlanSystemPrompt("base prompt", {
			active: true,
			cancelled: false,
			planPath: ".pi/plans/example.md",
		});

		assert.match(prompt ?? "", /call create_plan/i);
		assert.match(prompt ?? "", /at `.pi\/plans\/example.md`/);
		assert.match(prompt ?? "", /without overwriting/i);
		assert.doesNotMatch(prompt ?? "", /Plan mode is inactive/);
	});
});

describe("preparePlanMutation", () => {
	it("redirects a legacy root PLAN.md write to the generated plan path", () => {
		const input = { path: "PLAN.md", content: "# Plan: Improve auth" };

		const isPlanMutation = preparePlanMutation("write", input, ".pi/plans/improve-auth.md");

		assert.equal(isPlanMutation, true);
		assert.equal(input.path, ".pi/plans/improve-auth.md");
	});

	it("redirects a legacy path with the built-in tools' optional @ prefix", () => {
		const input = { path: "@PLAN.md", content: "# Plan: Improve auth" };

		const isPlanMutation = preparePlanMutation("write", input, ".pi/plans/improve-auth.md");

		assert.equal(isPlanMutation, true);
		assert.equal(input.path, ".pi/plans/improve-auth.md");
	});
});
