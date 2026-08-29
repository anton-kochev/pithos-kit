import assert from "node:assert/strict";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { execFile, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import {
	createPlanFileAtPath,
	generatePlanPath,
	PlanPublicationConflictError,
	resolveAvailablePlanPath,
	updatePlanFileAtPath,
	verifyPlanFileDigest,
} from "../extensions/plan-files.ts";
import { MAX_PLAN_CHECKPOINT_BYTES, planContentDigest } from "../extensions/plan-state.ts";

const execFileAsync = promisify(execFile);
const PLAN_FILES_MODULE_URL = new URL("../extensions/plan-files.ts", import.meta.url).href;

async function expectChildPublicationConflict(
	operation: "verify" | "update",
	cwd: string,
	planPath: string,
	expectedDigest: string,
): Promise<void> {
	const script = `
		const { updatePlanFileAtPath, verifyPlanFileDigest } = await import(${JSON.stringify(PLAN_FILES_MODULE_URL)});
		try {
			if (${JSON.stringify(operation)} === "verify") {
				await verifyPlanFileDigest(${JSON.stringify(cwd)}, ${JSON.stringify(planPath)}, ${JSON.stringify(expectedDigest)});
			} else {
				await updatePlanFileAtPath(${JSON.stringify(cwd)}, ${JSON.stringify(planPath)}, "replacement", ${JSON.stringify(expectedDigest)});
			}
			console.error("publication unexpectedly succeeded");
			process.exitCode = 2;
		} catch (error) {
			if (error?.code !== "PLAN_PUBLICATION_CONFLICT") {
				console.error(error?.stack ?? error);
				process.exitCode = 3;
			}
		}
	`;
	const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});

	await new Promise<void>((resolve, reject) => {
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, 5_000);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timeout);
			if (timedOut) {
				reject(new Error(`${operation} blocked on a special publication entry`));
				return;
			}
			if (code !== 0) {
				reject(new Error(`${operation} probe exited with ${code ?? signal}: ${stderr.trim()}`));
				return;
			}
			resolve();
		});
	});
}

function abortOnTemporaryFileObservation(
	plansDirectory: string,
	observationToAbort: number,
): AbortSignal {
	const reason = new DOMException("The publication was aborted.", "AbortError");
	let observations = 0;
	let aborted = false;
	return {
		get aborted() {
			return aborted;
		},
		get reason() {
			return reason;
		},
		throwIfAborted() {
			if (
				readdirSync(plansDirectory).some((name) => name.endsWith(".tmp")) &&
				++observations === observationToAbort
			) {
				aborted = true;
				throw reason;
			}
		},
	} as AbortSignal;
}

async function occupyFileMutationQueue(absolutePath: string): Promise<{
	release: () => void;
	done: Promise<void>;
}> {
	const started = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	const done = withFileMutationQueue(absolutePath, async () => {
		started.resolve();
		await gate.promise;
	});
	await started.promise;
	return { release: gate.resolve, done };
}

async function assertOperationWaitsForQueue(operation: Promise<unknown>): Promise<void> {
	const status = await Promise.race([
		operation.then(
			() => "settled" as const,
			() => "settled" as const,
		),
		new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 50)),
	]);
	assert.equal(status, "waiting");
}

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-files-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function withTempProject(
	run: (cwd: string, outsideDirectory: string) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-plan-parent-safety-"));
	const cwd = join(root, "project");
	const outsideDirectory = join(root, "outside");
	try {
		await mkdir(cwd);
		await mkdir(outsideDirectory);
		await run(cwd, outsideDirectory);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

type UnsafeParent = ".pi" | ".pi/plans";

async function symlinkPlanParent(
	cwd: string,
	outsideDirectory: string,
	parent: UnsafeParent,
): Promise<void> {
	if (parent === ".pi") {
		await mkdir(join(outsideDirectory, "plans"));
		await symlink(outsideDirectory, join(cwd, ".pi"), "dir");
		return;
	}
	await mkdir(join(cwd, ".pi"));
	await symlink(outsideDirectory, join(cwd, ".pi", "plans"), "dir");
}

function escapedPlanPath(
	outsideDirectory: string,
	parent: UnsafeParent,
	planPath: string,
): string {
	return parent === ".pi"
		? join(outsideDirectory, "plans", basename(planPath))
		: join(outsideDirectory, basename(planPath));
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

describe("plan publication parent safety", () => {
	const planPath = ".pi/plans/2026-06-29-231507-improve-auth.md";

	it("does not create .pi or plans during collision preflight", async () => {
		await withTempDirectory(async (cwd) => {
			assert.equal(await resolveAvailablePlanPath(cwd, planPath), planPath);
			await assert.rejects(lstat(join(cwd, ".pi")), { code: "ENOENT" });
		});
	});

	for (const parent of [".pi", ".pi/plans"] as const) {
		it(`rejects a ${parent} symlink during generation and collision preflight`, async () => {
			await withTempProject(async (cwd, outsideDirectory) => {
				await symlinkPlanParent(cwd, outsideDirectory, parent);

				await assert.rejects(
					generatePlanPath(cwd, ".pi", "Improve auth", new Date("2026-06-29T23:15:07Z")),
					/symbolic link|safe directory/i,
				);
				await assert.rejects(
					resolveAvailablePlanPath(cwd, planPath),
					/symbolic link|safe directory/i,
				);
				await assert.rejects(readFile(escapedPlanPath(outsideDirectory, parent, planPath), "utf8"), {
					code: "ENOENT",
				});
			});
		});

		it(`does not follow a ${parent} symlink while creating an approved plan`, async () => {
			await withTempProject(async (cwd, outsideDirectory) => {
				await symlinkPlanParent(cwd, outsideDirectory, parent);

				await assert.rejects(
					createPlanFileAtPath(cwd, planPath, "approved plan"),
					/symbolic link|safe directory/i,
				);
				await assert.rejects(readFile(escapedPlanPath(outsideDirectory, parent, planPath), "utf8"), {
					code: "ENOENT",
				});
			});
		});

		it(`treats a ${parent} symlink as a conflict during verify and update`, async () => {
			await withTempProject(async (cwd, outsideDirectory) => {
				await symlinkPlanParent(cwd, outsideDirectory, parent);
				const escapedPath = escapedPlanPath(outsideDirectory, parent, planPath);
				await writeFile(escapedPath, "published plan");
				const expectedDigest = planContentDigest("published plan");

				await assert.rejects(
					verifyPlanFileDigest(cwd, planPath, expectedDigest),
					PlanPublicationConflictError,
				);
				await assert.rejects(
					updatePlanFileAtPath(cwd, planPath, "new checkpoint", expectedDigest),
					PlanPublicationConflictError,
				);
				assert.equal(await readFile(escapedPath, "utf8"), "published plan");
			});
		});
	}

	it("rejects non-directory .pi and .pi/plans parent components", async () => {
		for (const parent of [".pi", ".pi/plans"] as const) {
			await withTempProject(async (cwd) => {
				if (parent === ".pi/plans") await mkdir(join(cwd, ".pi"));
				await writeFile(join(cwd, ...parent.split("/")), "not a directory");

				await assert.rejects(resolveAvailablePlanPath(cwd, planPath), /safe directory/i);
				await assert.rejects(createPlanFileAtPath(cwd, planPath, "plan"), /safe directory/i);
			});
		}
	});

	it("rejects lexical publication paths outside .pi/plans", async () => {
		await withTempProject(async (cwd, outsideDirectory) => {
			const outsidePath = join(outsideDirectory, "escaped.md");
			await assert.rejects(createPlanFileAtPath(cwd, "../outside/escaped.md", "plan"), /\.pi\/plans/i);
			await assert.rejects(readFile(outsidePath, "utf8"), { code: "ENOENT" });
		});
	});
});

describe("createPlanFileAtPath", () => {
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

	it("cleans the prepared temp file when aborted immediately before the atomic link", async () => {
		await withTempDirectory(async (cwd) => {
			const planPath = ".pi/plans/2026-06-29-231507-aborted-link.md";
			const plansDirectory = join(cwd, ".pi", "plans");
			const absolutePath = join(cwd, planPath);
			await mkdir(plansDirectory, { recursive: true });
			const signal = abortOnTemporaryFileObservation(plansDirectory, 1);

			await assert.rejects(
				createPlanFileAtPath(cwd, planPath, "must not publish", signal),
				(error: unknown) => error === signal.reason,
			);

			await assert.rejects(readFile(absolutePath, "utf8"), { code: "ENOENT" });
			assert.deepEqual(
				(await readdir(plansDirectory)).filter((name) => name.endsWith(".tmp")),
				[],
			);
		});
	});

	it("does not publish or leave a temp file when aborted while waiting for the mutation queue", async () => {
		await withTempDirectory(async (cwd) => {
			const planPath = ".pi/plans/2026-06-29-231507-aborted-create.md";
			const plansDirectory = join(cwd, ".pi", "plans");
			const absolutePath = join(cwd, planPath);
			await mkdir(plansDirectory, { recursive: true });
			const occupied = await occupyFileMutationQueue(absolutePath);
			const controller = new AbortController();
			const publication = createPlanFileAtPath(cwd, planPath, "must not publish", controller.signal);

			try {
				await assertOperationWaitsForQueue(publication);
				controller.abort();
			} finally {
				occupied.release();
				await occupied.done;
			}

			await assert.rejects(publication, { name: "AbortError" });
			await assert.rejects(readFile(absolutePath, "utf8"), { code: "ENOENT" });
			assert.deepEqual(
				(await readdir(plansDirectory)).filter((name) => name.endsWith(".tmp")),
				[],
			);
		});
	});
});

describe("published-file verification", { concurrency: false }, () => {
	const planPath = ".pi/plans/2026-06-29-231507-improve-auth.md";

	for (const operation of ["verify", "update"] as const) {
		it(`rejects a FIFO during ${operation} without blocking or replacing it`, {
			skip: process.platform === "win32",
		}, async () => {
			await withTempDirectory(async (cwd) => {
				const absolutePath = join(cwd, planPath);
				await mkdir(join(cwd, ".pi", "plans"), { recursive: true });
				await execFileAsync("mkfifo", [absolutePath]);

				await expectChildPublicationConflict(
					operation,
					cwd,
					planPath,
					planContentDigest("published plan"),
				);

				assert.equal((await lstat(absolutePath)).isFIFO(), true);
			});
		});
	}

	it("rejects an oversized regular file during verification even when its digest matches", async () => {
		await withTempDirectory(async (cwd) => {
			const absolutePath = join(cwd, planPath);
			const oversized = "x".repeat(MAX_PLAN_CHECKPOINT_BYTES + 1);
			await mkdir(join(cwd, ".pi", "plans"), { recursive: true });
			await writeFile(absolutePath, oversized);

			await assert.rejects(
				verifyPlanFileDigest(cwd, planPath, planContentDigest(oversized)),
				(error: unknown) => error instanceof PlanPublicationConflictError && /limit|too large|oversized/i.test(error.message),
			);
			assert.equal((await lstat(absolutePath)).size, MAX_PLAN_CHECKPOINT_BYTES + 1);
		});
	});

	it("rejects an oversized regular file during update without overwriting it", async () => {
		await withTempDirectory(async (cwd) => {
			const absolutePath = join(cwd, planPath);
			const oversized = "x".repeat(MAX_PLAN_CHECKPOINT_BYTES + 1);
			await mkdir(join(cwd, ".pi", "plans"), { recursive: true });
			await writeFile(absolutePath, oversized);

			await assert.rejects(
				updatePlanFileAtPath(cwd, planPath, "replacement", planContentDigest(oversized)),
				(error: unknown) => error instanceof PlanPublicationConflictError && /limit|too large|oversized/i.test(error.message),
			);
			assert.equal(await readFile(absolutePath, "utf8"), oversized);
		});
	});
});

describe("updatePlanFileAtPath", { concurrency: false }, () => {
	it("cleans the prepared temp file when aborted immediately before the atomic rename", async () => {
		await withTempDirectory(async (cwd) => {
			const planPath = ".pi/plans/2026-06-29-231507-aborted-rename.md";
			const plansDirectory = join(cwd, ".pi", "plans");
			const absolutePath = join(cwd, planPath);
			const originalContent = "published revision one";
			await mkdir(plansDirectory, { recursive: true });
			await writeFile(absolutePath, originalContent);
			const signal = abortOnTemporaryFileObservation(plansDirectory, 2);

			await assert.rejects(
				updatePlanFileAtPath(
					cwd,
					planPath,
					"must not replace the publication",
					planContentDigest(originalContent),
					signal,
				),
				(error: unknown) => error === signal.reason,
			);

			assert.equal(await readFile(absolutePath, "utf8"), originalContent);
			assert.deepEqual(
				(await readdir(plansDirectory)).filter((name) => name.endsWith(".tmp")),
				[],
			);
		});
	});

	it("does not update or leave a temp file when aborted while waiting for the mutation queue", async () => {
		await withTempDirectory(async (cwd) => {
			const planPath = ".pi/plans/2026-06-29-231507-aborted-update.md";
			const plansDirectory = join(cwd, ".pi", "plans");
			const absolutePath = join(cwd, planPath);
			const originalContent = "published revision one";
			await mkdir(plansDirectory, { recursive: true });
			await writeFile(absolutePath, originalContent);
			const occupied = await occupyFileMutationQueue(absolutePath);
			const controller = new AbortController();
			const update = updatePlanFileAtPath(
				cwd,
				planPath,
				"must not replace the publication",
				planContentDigest(originalContent),
				controller.signal,
			);

			try {
				await assertOperationWaitsForQueue(update);
				controller.abort();
			} finally {
				occupied.release();
				await occupied.done;
			}

			await assert.rejects(update, { name: "AbortError" });
			assert.equal(await readFile(absolutePath, "utf8"), originalContent);
			assert.deepEqual(
				(await readdir(plansDirectory)).filter((name) => name.endsWith(".tmp")),
				[],
			);
		});
	});

	it("serializes the whole replacement window with cooperating Pi file mutations", async () => {
		await withTempDirectory(async (cwd) => {
			const path = ".pi/plans/2026-06-29-231507-improve-auth.md";
			const absolutePath = join(cwd, path);
			await mkdir(join(cwd, ".pi", "plans"), { recursive: true });
			await writeFile(absolutePath, "published revision one");

			let releaseQueue: (() => void) | undefined;
			let markQueueStarted: (() => void) | undefined;
			const queueStarted = new Promise<void>((resolve) => {
				markQueueStarted = resolve;
			});
			const queueGate = new Promise<void>((resolve) => {
				releaseQueue = resolve;
			});
			const queuedMutation = withFileMutationQueue(absolutePath, async () => {
				markQueueStarted?.();
				await queueGate;
			});
			await queueStarted;

			const probe = await open(absolutePath, "r");
			const fileHandlePrototype = Object.getPrototypeOf(probe) as {
				sync: () => Promise<void>;
			};
			await probe.close();
			const originalSync = fileHandlePrototype.sync;
			let markTemporarySync: (() => void) | undefined;
			const temporarySyncStarted = new Promise<void>((resolve) => {
				markTemporarySync = resolve;
			});
			fileHandlePrototype.sync = async function sync(): Promise<void> {
				markTemporarySync?.();
				return originalSync.call(this);
			};

			const update = updatePlanFileAtPath(
				cwd,
				path,
				"published revision two",
				planContentDigest("published revision one"),
			);
			const stateWhileQueued = await Promise.race([
				temporarySyncStarted.then(() => "started" as const),
				new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
			]);
			releaseQueue?.();
			try {
				await queuedMutation;
				await update;
			} finally {
				fileHandlePrototype.sync = originalSync;
			}

			assert.equal(stateWhileQueued, "blocked");
			assert.equal(await readFile(absolutePath, "utf8"), "published revision two");
		});
	});

	it("detects a mutation after temporary preparation and before the final commit section", async () => {
		await withTempDirectory(async (cwd) => {
			const path = ".pi/plans/2026-06-29-231507-improve-auth.md";
			const absolutePath = join(cwd, path);
			await mkdir(join(cwd, ".pi", "plans"), { recursive: true });
			await writeFile(absolutePath, "published revision one");

			const probe = await open(absolutePath, "r");
			const fileHandlePrototype = Object.getPrototypeOf(probe) as {
				sync: () => Promise<void>;
			};
			await probe.close();
			const originalSync = fileHandlePrototype.sync;
			let mutated = false;
			fileHandlePrototype.sync = async function sync(): Promise<void> {
				await originalSync.call(this);
				if (!mutated) {
					mutated = true;
					await writeFile(absolutePath, "external mutation");
				}
			};

			try {
				await assert.rejects(
					updatePlanFileAtPath(
						cwd,
						path,
						"published revision two",
						planContentDigest("published revision one"),
					),
					PlanPublicationConflictError,
				);
			} finally {
				fileHandlePrototype.sync = originalSync;
			}
			assert.equal(await readFile(absolutePath, "utf8"), "external mutation");
		});
	});

	it("atomically replaces the stable published path only when its exact bytes still match", async () => {
		await withTempDirectory(async (cwd) => {
			const path = ".pi/plans/2026-06-29-231507-improve-auth.md";
			await mkdir(join(cwd, ".pi", "plans"), { recursive: true });
			await writeFile(join(cwd, path), "published revision one");
			const expectedDigest = planContentDigest("published revision one");

			const result = await updatePlanFileAtPath(cwd, path, "published revision two", expectedDigest);

			assert.deepEqual(result, { path, unchanged: false });
			assert.equal(await readFile(join(cwd, path), "utf8"), "published revision two");
		});
	});

	it("performs no write when the checkpoint digest is already published", async () => {
		await withTempDirectory(async (cwd) => {
			const path = ".pi/plans/2026-06-29-231507-improve-auth.md";
			const absolutePath = join(cwd, path);
			await mkdir(join(cwd, ".pi", "plans"), { recursive: true });
			await writeFile(absolutePath, "unchanged plan");
			const before = await lstat(absolutePath);
			const expectedDigest = planContentDigest("unchanged plan");

			const result = await updatePlanFileAtPath(cwd, path, "unchanged plan", expectedDigest);
			const after = await lstat(absolutePath);

			assert.deepEqual(result, { path, unchanged: true });
			assert.equal(after.ino, before.ino);
			assert.equal(after.mtimeMs, before.mtimeMs);
		});
	});

	it("never overwrites externally changed, deleted, symlink, or directory destinations", async () => {
		await withTempDirectory(async (cwd) => {
			const path = ".pi/plans/2026-06-29-231507-improve-auth.md";
			const absolutePath = join(cwd, path);
			const expectedDigest = planContentDigest("unchanged plan");
			await mkdir(join(cwd, ".pi", "plans"), { recursive: true });

			await writeFile(absolutePath, "external edit");
			await assert.rejects(
				updatePlanFileAtPath(cwd, path, "new checkpoint", expectedDigest),
				PlanPublicationConflictError,
			);
			assert.equal(await readFile(absolutePath, "utf8"), "external edit");

			await rm(absolutePath);
			await assert.rejects(
				updatePlanFileAtPath(cwd, path, "new checkpoint", expectedDigest),
				PlanPublicationConflictError,
			);

			await symlink("other.md", absolutePath);
			await assert.rejects(
				updatePlanFileAtPath(cwd, path, "new checkpoint", expectedDigest),
				PlanPublicationConflictError,
			);
			await rm(absolutePath);

			await mkdir(absolutePath);
			await assert.rejects(
				updatePlanFileAtPath(cwd, path, "new checkpoint", expectedDigest),
				PlanPublicationConflictError,
			);
		});
	});
});
