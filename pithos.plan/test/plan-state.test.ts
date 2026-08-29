import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	MAX_PLAN_CHECKPOINT_BYTES,
	completedPublicationMatchesActiveCheckpoint,
	createPlanCheckpoint,
	planContentDigest,
	readPlanLifecycleState,
	reconstructPlanSession,
	type PersistedPlanLifecycleState,
} from "../extensions/plan-state.ts";

const identity = {
	ownerSessionId: "session-a",
	planId: "plan-a",
	candidatePath: ".pi/plans/2026-09-01-120000-plan.md",
};

function lifecycle(overrides: Partial<PersistedPlanLifecycleState> = {}) {
	return {
		type: "custom",
		customType: "plan-theme-state",
		data: {
			version: 1,
			active: true,
			publicationState: "unpublished",
			...identity,
			...overrides,
		},
	};
}

function checkpointEntry(content: string, revision: number, ownerSessionId = identity.ownerSessionId) {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "update_plan_draft",
			isError: false,
			details: {
				version: 1,
				ownerSessionId,
				planId: identity.planId,
				revision,
				digest: planContentDigest(content),
				content,
			},
		},
	};
}

describe("createPlanCheckpoint", () => {
	it("stores the exact full Markdown snapshot and advances the expected branch revision", () => {
		const content = "# Plan: Exact bytes\n\n- requirement\n";
		const first = createPlanCheckpoint(identity, undefined, content, 0);
		const second = createPlanCheckpoint(identity, first, content + "- decision\n", 1);

		assert.equal(first.content, content);
		assert.equal(first.revision, 1);
		assert.equal(first.digest, planContentDigest(content));
		assert.equal(second.revision, 2);
		assert.equal(second.content, content + "- decision\n");
	});

	it("rejects stale revisions, empty snapshots, and oversized UTF-8 content", () => {
		const current = createPlanCheckpoint(identity, undefined, "# Plan", 0);
		assert.throws(
			() => createPlanCheckpoint(identity, current, "# Changed", 0),
			/expected revision 1.*received 0/i,
		);
		assert.throws(() => createPlanCheckpoint(identity, current, "  \n", 1), /must not be empty/i);
		assert.throws(
			() => createPlanCheckpoint(identity, current, "🚀".repeat(MAX_PLAN_CHECKPOINT_BYTES), 1),
			/checkpoint is too large/i,
		);
	});
});

describe("completedPublicationMatchesActiveCheckpoint", () => {
	it("requires the active synced publication and branch checkpoint to match by identity, path, revision, and digest", () => {
		const checkpoint = createPlanCheckpoint(identity, undefined, "# Plan: Exact completion\n", 0);
		const state: PersistedPlanLifecycleState = {
			version: 1,
			active: true,
			...identity,
			publishedPath: identity.candidatePath,
			publishedRevision: checkpoint.revision,
			publishedDigest: checkpoint.digest,
			publicationState: "synced",
			checkpointRevision: checkpoint.revision,
			checkpointDigest: checkpoint.digest,
			completedPublication: {
				action: "exit",
				revision: checkpoint.revision,
				digest: checkpoint.digest,
				path: identity.candidatePath,
			},
		};

		assert.equal(completedPublicationMatchesActiveCheckpoint(state, checkpoint), true);
		assert.equal(completedPublicationMatchesActiveCheckpoint(state, undefined), false);
		assert.equal(completedPublicationMatchesActiveCheckpoint(
			{ ...state, active: false },
			checkpoint,
		), false);
		assert.equal(completedPublicationMatchesActiveCheckpoint(
			{ ...state, publicationState: "dirty" },
			checkpoint,
		), false);
		assert.equal(completedPublicationMatchesActiveCheckpoint(
			{ ...state, publishedPath: ".pi/plans/other.md" },
			checkpoint,
		), false);
		assert.equal(completedPublicationMatchesActiveCheckpoint(
			state,
			{ ...checkpoint, ownerSessionId: "other-session" },
		), false);
		assert.equal(completedPublicationMatchesActiveCheckpoint(
			state,
			{ ...checkpoint, planId: "other-plan" },
		), false);
		assert.equal(completedPublicationMatchesActiveCheckpoint(
			state,
			{ ...checkpoint, revision: checkpoint.revision + 1 },
		), false);
		assert.equal(completedPublicationMatchesActiveCheckpoint(
			state,
			{ ...checkpoint, digest: planContentDigest("other checkpoint") },
		), false);
	});
});

describe("readPlanLifecycleState", () => {
	it("fails closed for inconsistent publication ownership and approval bindings", () => {
		const publishedDigest = planContentDigest("published");
		assert.equal(readPlanLifecycleState({
			version: 1,
			active: true,
			...identity,
			publishedPath: ".pi/plans/other.md",
			publishedRevision: 1,
			publishedDigest,
			publicationState: "synced",
		}), undefined);
		assert.equal(readPlanLifecycleState({
			version: 1,
			active: true,
			...identity,
			publishedPath: identity.candidatePath,
			publishedRevision: 1,
			publishedDigest,
			publicationState: "synced",
			approval: {
				action: "save",
				kind: "update",
				revision: 2,
				digest: planContentDigest("next"),
				path: identity.candidatePath,
				expectedPublishedDigest: planContentDigest("wrong base"),
			},
		}), undefined);
	});

	it("validates the crash-recovery session name stored with a completed publication", () => {
		const publishedDigest = planContentDigest("published");
		const completed = {
			version: 1,
			active: true,
			...identity,
			publishedPath: identity.candidatePath,
			publishedRevision: 1,
			publishedDigest,
			publicationState: "synced",
			completedPublication: {
				action: "save",
				revision: 1,
				digest: publishedDigest,
				path: identity.candidatePath,
				sessionName: "contextual-plan-name",
			},
		};

		assert.equal(
			readPlanLifecycleState(completed)?.completedPublication?.sessionName,
			"contextual-plan-name",
		);
		assert.equal(readPlanLifecycleState({
			...completed,
			completedPublication: {
				...completed.completedPublication,
				sessionName: "Unsafe Name",
			},
		}), undefined);
	});
});

describe("reconstructPlanSession", () => {
	it("uses physical-session identity globally but restores checkpoint content only from the active branch", () => {
		const state = lifecycle();
		const branchACheckpoint = checkpointEntry("# Branch A", 1);
		const branchBCheckpoint = checkpointEntry("# Branch B", 1);
		const allEntries = [state, branchACheckpoint, branchBCheckpoint];

		const branchA = reconstructPlanSession(allEntries, [state, branchACheckpoint], "session-a");
		const branchB = reconstructPlanSession(allEntries, [state, branchBCheckpoint], "session-a");
		const beforeCheckpoint = reconstructPlanSession(allEntries, [state], "session-a");

		assert.equal(branchA.checkpoint?.content, "# Branch A");
		assert.equal(branchB.checkpoint?.content, "# Branch B");
		assert.equal(beforeCheckpoint.checkpoint, undefined);
		assert.equal(branchA.state?.planId, branchB.state?.planId);
	});

	it("keeps completed publication recovery branch-local when sibling checkpoints have the same revision and digest", () => {
		const content = "# Identical checkpoint";
		const checkpointDigest = planContentDigest(content);
		const published = {
			publishedPath: identity.candidatePath,
			publishedRevision: 1,
			publishedDigest: checkpointDigest,
			publicationState: "synced" as const,
			checkpointRevision: 1,
			checkpointDigest,
		};
		const siblingState = lifecycle(published);
		const originatingState = lifecycle({
			...published,
			completedPublication: {
				action: "exit",
				revision: 1,
				digest: checkpointDigest,
				path: identity.candidatePath,
			},
		});
		const siblingCheckpoint = checkpointEntry(content, 1);
		const originatingCheckpoint = checkpointEntry(content, 1);
		const allEntries = [siblingState, siblingCheckpoint, originatingCheckpoint, originatingState];

		const sibling = reconstructPlanSession(
			allEntries,
			[siblingState, siblingCheckpoint],
			"session-a",
		);
		const originating = reconstructPlanSession(
			allEntries,
			[originatingCheckpoint, originatingState],
			"session-a",
		);

		assert.equal(sibling.state?.publishedPath, identity.candidatePath);
		assert.equal(sibling.state?.publishedRevision, 1);
		assert.equal(sibling.state?.publishedDigest, checkpointDigest);
		assert.equal(sibling.state?.completedPublication, undefined);
		assert.deepEqual(originating.state?.completedPublication, {
			action: "exit",
			revision: 1,
			digest: checkpointDigest,
			path: identity.candidatePath,
		});
	});

	it("keeps the active branch checkpoint authoritative over a stale completed publication", () => {
		const revisionOne = checkpointEntry("# Published revision one", 1);
		const publishedDigest = revisionOne.message.details.digest;
		const completedState = lifecycle({
			publishedPath: identity.candidatePath,
			publishedRevision: 1,
			publishedDigest,
			publicationState: "synced",
			checkpointRevision: 1,
			checkpointDigest: publishedDigest,
			completedPublication: {
				action: "exit",
				revision: 1,
				digest: publishedDigest,
				path: identity.candidatePath,
			},
		});
		const revisionTwo = checkpointEntry("# Dirty revision two", 2);
		const entries = [revisionOne, completedState, revisionTwo];

		const restored = reconstructPlanSession(entries, entries, "session-a");

		assert.equal(restored.checkpoint?.revision, 2);
		assert.equal(restored.state?.completedPublication?.revision, 1);
		assert.equal(
			completedPublicationMatchesActiveCheckpoint(restored.state, restored.checkpoint),
			false,
		);
	});

	it("does not inherit ownership or checkpoints when a fork has a different physical session id", () => {
		const entries = [lifecycle(), checkpointEntry("# Parent plan", 1)];

		const restored = reconstructPlanSession(entries, entries, "fork-session");

		assert.equal(restored.state, undefined);
		assert.equal(restored.checkpoint, undefined);
		assert.equal(restored.foreignState, true);
	});

	it("fails closed when one physical session contains multiple logical plan identities", () => {
		const entries = [
			lifecycle(),
			lifecycle({ planId: "plan-b", candidatePath: ".pi/plans/2026-09-01-120001-plan.md" }),
		];

		const restored = reconstructPlanSession(entries, entries, "session-a");

		assert.equal(restored.state, undefined);
		assert.equal(restored.checkpoint, undefined);
		assert.equal(restored.issue, "multiple-plan-identities");
	});

	it("ignores malformed or digest-mismatched checkpoint details", () => {
		const state = lifecycle();
		const malformed = checkpointEntry("# Tampered", 1);
		malformed.message.details.digest = "0".repeat(64);

		const restored = reconstructPlanSession([state, malformed], [state, malformed], "session-a");

		assert.equal(restored.state?.active, true);
		assert.equal(restored.checkpoint, undefined);
	});
});
