import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyTaskOperation, createEmptyArtifact, type TaskArtifact, type TaskStatus } from "../src/tasks";

const now1 = () => new Date("2026-06-02T12:00:00.000Z");
const now2 = () => new Date("2026-06-02T13:00:00.000Z");

function createdArtifact(): TaskArtifact {
	return applyTaskOperation(createEmptyArtifact(), { action: "create", title: "Write tests" }, now1, () => "abc123ef").artifact;
}

describe("task operations", () => {
	it("creates tasks with stable sequence IDs, defaults, ISO timestamps, and empty notes", () => {
		const hashes = ["abc123ef", "fed456ba"];
		const nextHash = () => hashes.shift()!;
		const first = applyTaskOperation(createEmptyArtifact(), { action: "create", title: "Write tests" }, now1, nextHash);
		const second = applyTaskOperation(first.artifact, { action: "create", title: "Implement Telos", priority: "high" }, now2, nextHash);

		assert.equal(first.task?.id, "TSK-abc123ef");
		assert.equal(first.task?.status, "todo");
		assert.equal(first.task?.priority, "medium");
		assert.equal(first.task?.notes, "");
		assert.deepEqual(first.task?.dependencies, []);
		assert.equal(first.task?.created, "2026-06-02T12:00:00.000Z");
		assert.equal(first.task?.updated, "2026-06-02T12:00:00.000Z");
		assert.equal(second.task?.id, "TSK-fed456ba");
		assert.equal(second.task?.priority, "high");
	});

	it("creates tasks with dependencies on existing tasks", () => {
		const first = applyTaskOperation(createEmptyArtifact(), { action: "create", title: "Foundation" }, now1, () => "abc123ef");
		const second = applyTaskOperation(
			first.artifact,
			{ action: "create", title: "Build on foundation", dependencies: ["TSK-abc123ef"] },
			now2,
			() => "fed456ba",
		);

		assert.deepEqual(second.task?.dependencies, ["TSK-abc123ef"]);
	});

	it("rejects dependencies on missing tasks and self", () => {
		const artifact = createdArtifact();
		assert.throws(
			() => applyTaskOperation(artifact, { action: "create", title: "Blocked", dependencies: ["TSK-missing1"] }, now2, () => "fed456ba"),
			/does not exist/,
		);
		assert.throws(
			() => applyTaskOperation(artifact, { action: "update", id: "TSK-abc123ef", dependencies: ["TSK-abc123ef"] }, now2),
			/cannot depend on itself/,
		);
	});

	it("updates only requested fields while preserving id and created timestamp", () => {
		const artifact = createdArtifact();
		const result = applyTaskOperation(artifact, { action: "update", id: "TSK-abc123ef", notes: "Some notes", dependencies: [] }, now2);

		const task = result.task!;
		assert.equal(task.id, "TSK-abc123ef");
		assert.equal(task.title, "Write tests");
		assert.equal(task.priority, "medium");
		assert.equal(task.notes, "Some notes");
		assert.deepEqual(task.dependencies, []);
		assert.equal(task.created, "2026-06-02T12:00:00.000Z");
		assert.equal(task.updated, "2026-06-02T13:00:00.000Z");
	});

	it("supports lifecycle status changes and archived filtering", () => {
		let artifact = createdArtifact();
		artifact = applyTaskOperation(artifact, { action: "create", title: "Keep active" }, now1, () => "fed456ba").artifact;
		artifact = applyTaskOperation(artifact, { action: "archive", id: "TSK-abc123ef" }, now2).artifact;

		const active = applyTaskOperation(artifact, { action: "list" }, now2);
		const archived = applyTaskOperation(artifact, { action: "list", scope: "archived" }, now2);
		const all = applyTaskOperation(artifact, { action: "list", scope: "all" }, now2);

		assert.deepEqual(active.tasks?.map((task) => task.id), ["TSK-fed456ba"]);
		assert.deepEqual(archived.tasks?.map((task) => task.id), ["TSK-abc123ef"]);
		assert.deepEqual(all.tasks?.map((task) => task.id), ["TSK-fed456ba", "TSK-abc123ef"]);
	});

	it("groups lists by status while preserving stored order within each group", () => {
		const statuses: TaskStatus[] = ["archived", "done", "todo", "blocked", "in_progress", "todo", "in_progress", "blocked", "done", "archived"];
		const artifact: TaskArtifact = {
			telos_version: 1,
			tasks: statuses.map((status, index) => ({
				...createdArtifact().tasks[0],
				id: `TSK-${index.toString().padStart(8, "0")}`,
				status,
				priority: index < 5 ? "low" : "urgent",
			})),
		};
		const original = structuredClone(artifact);
		for (const [scope, indices] of [
			["active", [4, 6, 3, 7, 2, 5, 1, 8]],
			["all", [4, 6, 3, 7, 2, 5, 1, 8, 0, 9]],
			["archived", [0, 9]],
		] as const) {
			const result = applyTaskOperation(artifact, { action: "list", scope }, now2);
			const expectedIds = indices.map((index) => artifact.tasks[index].id);
			assert.deepEqual(result.tasks?.map((task) => task.id), expectedIds, scope);
			assert.deepEqual(result.text.split("\n").map((line) => line.split(" ")[0]), expectedIds, scope);
			assert.deepEqual(result.artifact, original);
			assert.deepEqual(artifact, original);
		}
	});

	it("lists completed active tasks after incomplete active tasks", () => {
		let artifact = createdArtifact();
		artifact = applyTaskOperation(artifact, { action: "complete", id: "TSK-abc123ef" }, now2).artifact;
		artifact = applyTaskOperation(artifact, { action: "create", title: "New open task" }, now1, () => "fed456ba").artifact;

		const active = applyTaskOperation(artifact, { action: "list" }, now2);

		assert.deepEqual(active.tasks?.map((task) => task.id), ["TSK-fed456ba", "TSK-abc123ef"]);
		assert.deepEqual(active.artifact.tasks.map((task) => task.id), ["TSK-abc123ef", "TSK-fed456ba"]);
	});

	it("rejects physical delete without removing the task", () => {
		const artifact = createdArtifact();
		const result = applyTaskOperation(artifact, { action: "delete", id: "TSK-abc123ef" }, now2);

		assert.equal(result.artifact.tasks.length, 1);
		assert.equal(result.artifact.tasks[0].status, "todo");
		assert.match(result.text, /not supported/i);
	});

	it("rejects invalid priority without mutating the original artifact", () => {
		const artifact = createdArtifact();
		assert.throws(
			() => applyTaskOperation(artifact, { action: "update", id: "TSK-abc123ef", priority: "extreme" as never }, now2),
			/Invalid priority/,
		);
		assert.equal(artifact.tasks[0].priority, "medium");
		assert.equal(artifact.tasks[0].updated, "2026-06-02T12:00:00.000Z");
	});
});
