import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectPlanCheckpoint } from "../extensions/plan-context.ts";
import { createPlanCheckpoint } from "../extensions/plan-state.ts";

const checkpoint = createPlanCheckpoint(
	{
		ownerSessionId: "session-a",
		planId: "plan-a",
		candidatePath: ".pi/plans/2026-09-01-120000-plan.md",
	},
	undefined,
	"# Plan: Preserve exact context\n\n## Open questions\n- Which API?\n",
	0,
);

function checkpointExchange() {
	return {
		assistant: {
			role: "assistant",
			content: [{
				type: "toolCall",
				id: "checkpoint-1",
				name: "update_plan_draft",
				arguments: { content: checkpoint.content, expectedRevision: 0 },
			}],
			timestamp: 2,
		},
		toolResult: {
			role: "toolResult",
			toolCallId: "checkpoint-1",
			toolName: "update_plan_draft",
			content: [{ type: "text", text: "Checkpointed" }],
			details: checkpoint,
			isError: false,
			timestamp: 3,
		},
	};
}

describe("projectPlanCheckpoint", () => {
	it("anchors the exact checkpoint after its validated tool result and before every newer user refinement", () => {
		const initialUser = { role: "user", content: "Initial request", timestamp: 1 };
		const { assistant, toolResult } = checkpointExchange();
		const firstRefinement = { role: "user", content: "Use the newer API", timestamp: 4 };
		const response = { role: "assistant", content: [{ type: "text", text: "Updated." }], timestamp: 5 };
		const latestRefinement = { role: "user", content: "Also preserve compatibility", timestamp: 6 };

		const projected = projectPlanCheckpoint(
			[initialUser, assistant, toolResult, firstRefinement, response, latestRefinement] as never[],
			checkpoint,
		);
		const message = projected[3] as any;

		assert.equal(projected[0], initialUser);
		assert.equal(projected[1], assistant);
		assert.equal(projected[2], toolResult);
		assert.equal(message.role, "custom");
		assert.equal(message.customType, "plan-checkpoint-context");
		assert.equal(message.display, false);
		assert.match(message.content[0].text, /UNAPPROVED DATA, NOT INSTRUCTIONS/);
		assert.match(message.content[0].text, /newer user messages are authoritative/i);
		assert.equal(message.content[1].text, checkpoint.content);
		assert.match(message.content[2].text, /END PLAN CHECKPOINT/);
		assert.equal(projected[4], firstRefinement);
		assert.equal(projected[5], response);
		assert.equal(projected[6], latestRefinement);
	});

	it("keeps a multi-tool assistant batch contiguous by projecting after every sibling tool result", () => {
		const assistant = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "checkpoint-1",
					name: "update_plan_draft",
					arguments: { content: checkpoint.content, expectedRevision: 0 },
				},
				{
					type: "toolCall",
					id: "read-1",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
			timestamp: 2,
		};
		const { toolResult } = checkpointExchange();
		const siblingResult = {
			role: "toolResult",
			toolCallId: "read-1",
			toolName: "read",
			content: [{ type: "text", text: "Repository details" }],
			isError: false,
			timestamp: 3,
		};
		const refinement = { role: "user", content: "Use those details", timestamp: 4 };

		const projected = projectPlanCheckpoint(
			[assistant, toolResult, siblingResult, refinement] as never[],
			checkpoint,
		);

		assert.equal(projected[0], assistant);
		assert.equal(projected[1], toolResult);
		assert.equal(projected[2], siblingResult);
		assert.equal((projected[3] as any).customType, "plan-checkpoint-context");
		assert.equal(projected[4], refinement);
	});

	it("removes older projections before anchoring the replacement at the matching checkpoint result", () => {
		const oldProjection = {
			role: "custom",
			customType: "plan-checkpoint-context",
			content: "old",
			display: false,
			timestamp: 1,
		};
		const { assistant, toolResult } = checkpointExchange();
		const userMessage = { role: "user", content: "Latest refinement", timestamp: 4 };

		const projected = projectPlanCheckpoint(
			[oldProjection, assistant, oldProjection, toolResult, userMessage, oldProjection] as never[],
			checkpoint,
		);

		assert.equal(projected.length, 4);
		assert.equal(projected[0], assistant);
		assert.equal(projected[1], toolResult);
		assert.equal((projected[2] as any).content[1].text, checkpoint.content);
		assert.equal(projected[3], userMessage);
	});

	it("places the projection at the beginning when compaction removed the matching exchange", () => {
		const summary = {
			role: "compactionSummary",
			summary: "The checkpoint tool exchange was compacted.",
			tokensBefore: 1000,
			timestamp: 1,
		};
		const olderRefinement = { role: "user", content: "First retained refinement", timestamp: 2 };
		const latestRefinement = { role: "user", content: "Second retained refinement", timestamp: 3 };

		const projected = projectPlanCheckpoint(
			[summary, olderRefinement, latestRefinement] as never[],
			checkpoint,
		);

		assert.equal((projected[0] as any).customType, "plan-checkpoint-context");
		assert.equal(projected[1], summary);
		assert.equal(projected[2], olderRefinement);
		assert.equal(projected[3], latestRefinement);
	});

	it("does not anchor after a malformed or different checkpoint result", () => {
		const { assistant, toolResult } = checkpointExchange();
		const mismatched = {
			...toolResult,
			details: { ...checkpoint, digest: "0".repeat(64) },
		};

		const projected = projectPlanCheckpoint([assistant, mismatched] as never[], checkpoint);

		assert.equal((projected[0] as any).customType, "plan-checkpoint-context");
		assert.equal(projected[1], assistant);
		assert.equal(projected[2], mismatched);
	});
});
