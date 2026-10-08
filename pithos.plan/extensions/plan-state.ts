import { createHash } from "node:crypto";

export const PLAN_STATE_ENTRY_TYPE = "plan-theme-state";
export const PLAN_CHECKPOINT_TOOL_NAME = "update_plan_draft";
export const PLAN_STATE_VERSION = 1;
export const MAX_PLAN_CHECKPOINT_BYTES = 64 * 1024;
export const MAX_PLAN_CHECKPOINT_CHARACTERS = 64 * 1024;

export type PlanPublicationState = "unpublished" | "dirty" | "synced" | "conflict";

export type PlanApprovalState = {
	action: "save" | "exit";
	kind: "create" | "update";
	revision: number;
	digest: string;
	path: string;
	expectedPublishedDigest?: string;
};

export type CompletedPlanPublication = {
	action: "save" | "exit";
	revision: number;
	digest: string;
	path: string;
	sessionName?: string;
};

export type PersistedPlanLifecycleState = {
	version: 1;
	active: boolean;
	ownerSessionId: string;
	planId: string;
	candidatePath: string;
	publishedPath?: string;
	publishedRevision?: number;
	publishedDigest?: string;
	publicationState: PlanPublicationState;
	checkpointRevision?: number;
	checkpointDigest?: string;
	approval?: PlanApprovalState;
	completedPublication?: CompletedPlanPublication;
	previousThemeName?: string;
	previousToolNames?: string[];
};

export type PlanCheckpointDetails = {
	version: 1;
	ownerSessionId: string;
	planId: string;
	revision: number;
	digest: string;
	content: string;
};

export type PlanIdentity = Pick<
	PersistedPlanLifecycleState,
	"ownerSessionId" | "planId" | "candidatePath"
>;

export function completedPublicationMatchesActiveCheckpoint(
	state: PersistedPlanLifecycleState | undefined,
	checkpoint: PlanCheckpointDetails | undefined,
): boolean {
	const completed = state?.completedPublication;
	return state?.active === true &&
		state.publicationState === "synced" &&
		completed !== undefined &&
		checkpoint !== undefined &&
		checkpoint.ownerSessionId === state.ownerSessionId &&
		checkpoint.planId === state.planId &&
		state.candidatePath === completed.path &&
		state.publishedPath === completed.path &&
		state.publishedRevision === completed.revision &&
		state.publishedDigest === completed.digest &&
		state.checkpointRevision === completed.revision &&
		state.checkpointDigest === completed.digest &&
		checkpoint.revision === completed.revision &&
		checkpoint.digest === completed.digest;
}

type UnknownRecord = Record<string, unknown>;

export type ReconstructedPlanSession = {
	state?: PersistedPlanLifecycleState;
	checkpoint?: PlanCheckpointDetails;
	foreignState: boolean;
	legacyState: boolean;
	issue?: "invalid-state" | "multiple-plan-identities";
};

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isPositiveRevision(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isSafePlanPath(value: unknown): value is string {
	if (typeof value !== "string" || value.includes("\0")) return false;
	const normalized = value.replaceAll("\\", "/");
	return /^\.pi\/plans\/[^/]+\.md$/u.test(normalized) && !normalized.split("/").includes("..");
}

function readCompletedPublication(value: unknown): CompletedPlanPublication | undefined {
	if (!isRecord(value) || (value.action !== "save" && value.action !== "exit")) return undefined;
	if (!isPositiveRevision(value.revision) || !isDigest(value.digest) || !isSafePlanPath(value.path)) {
		return undefined;
	}
	if (
		value.sessionName !== undefined &&
		(typeof value.sessionName !== "string" ||
			value.sessionName.length > 120 ||
			!(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.sessionName)))
	) {
		return undefined;
	}
	return {
		action: value.action,
		revision: value.revision,
		digest: value.digest,
		path: value.path,
		...(typeof value.sessionName === "string" ? { sessionName: value.sessionName } : {}),
	};
}

function readApproval(value: unknown): PlanApprovalState | undefined {
	if (!isRecord(value)) return undefined;
	if (value.action !== "save" && value.action !== "exit") return undefined;
	if (value.kind !== "create" && value.kind !== "update") return undefined;
	if (!isPositiveRevision(value.revision) || !isDigest(value.digest) || !isSafePlanPath(value.path)) {
		return undefined;
	}
	if (value.expectedPublishedDigest !== undefined && !isDigest(value.expectedPublishedDigest)) return undefined;
	if (value.kind === "update" && value.expectedPublishedDigest === undefined) return undefined;
	return {
		action: value.action,
		kind: value.kind,
		revision: value.revision,
		digest: value.digest,
		path: value.path,
		...(typeof value.expectedPublishedDigest === "string"
			? { expectedPublishedDigest: value.expectedPublishedDigest }
			: {}),
	};
}

export function readPlanLifecycleState(value: unknown): PersistedPlanLifecycleState | undefined {
	if (!isRecord(value) || value.version !== PLAN_STATE_VERSION || typeof value.active !== "boolean") {
		return undefined;
	}
	if (
		typeof value.ownerSessionId !== "string" || value.ownerSessionId.length === 0 ||
		typeof value.planId !== "string" || value.planId.length === 0 ||
		!isSafePlanPath(value.candidatePath)
	) {
		return undefined;
	}
	if (!(["unpublished", "dirty", "synced", "conflict"] as const).includes(value.publicationState as PlanPublicationState)) {
		return undefined;
	}

	const hasPublishedValue = value.publishedPath !== undefined || value.publishedRevision !== undefined || value.publishedDigest !== undefined;
	if (hasPublishedValue && (
		!isSafePlanPath(value.publishedPath) ||
		!isPositiveRevision(value.publishedRevision) ||
		!isDigest(value.publishedDigest) ||
		value.publishedPath !== value.candidatePath ||
		value.publicationState === "unpublished"
	)) {
		return undefined;
	}
	if (!hasPublishedValue && value.publicationState !== "unpublished") return undefined;
	if (value.checkpointRevision !== undefined && !isPositiveRevision(value.checkpointRevision)) return undefined;
	if (value.checkpointDigest !== undefined && !isDigest(value.checkpointDigest)) return undefined;
	if ((value.checkpointRevision === undefined) !== (value.checkpointDigest === undefined)) return undefined;
	if (value.previousThemeName !== undefined && typeof value.previousThemeName !== "string") return undefined;
	if (
		value.previousToolNames !== undefined &&
		(!Array.isArray(value.previousToolNames) || value.previousToolNames.some((name) => typeof name !== "string"))
	) {
		return undefined;
	}
	const approval = value.approval === undefined ? undefined : readApproval(value.approval);
	if (value.approval !== undefined && approval === undefined) return undefined;
	if (approval && (
		approval.path !== (hasPublishedValue ? value.publishedPath : value.candidatePath) ||
		(approval.kind === "create" && hasPublishedValue) ||
		(approval.kind === "update" && (
			!hasPublishedValue || approval.expectedPublishedDigest !== value.publishedDigest
		))
	)) {
		return undefined;
	}
	const completedPublication = value.completedPublication === undefined
		? undefined
		: readCompletedPublication(value.completedPublication);
	if (value.completedPublication !== undefined && completedPublication === undefined) return undefined;
	if (approval && completedPublication) return undefined;
	if (completedPublication && (
		!hasPublishedValue ||
		completedPublication.path !== value.publishedPath ||
		completedPublication.revision !== value.publishedRevision ||
		completedPublication.digest !== value.publishedDigest
	)) {
		return undefined;
	}

	return {
		version: PLAN_STATE_VERSION,
		active: value.active,
		ownerSessionId: value.ownerSessionId,
		planId: value.planId,
		candidatePath: value.candidatePath,
		publicationState: value.publicationState as PlanPublicationState,
		...(typeof value.publishedPath === "string" ? { publishedPath: value.publishedPath } : {}),
		...(typeof value.publishedRevision === "number" ? { publishedRevision: value.publishedRevision } : {}),
		...(typeof value.publishedDigest === "string" ? { publishedDigest: value.publishedDigest } : {}),
		...(typeof value.checkpointRevision === "number" ? { checkpointRevision: value.checkpointRevision } : {}),
		...(typeof value.checkpointDigest === "string" ? { checkpointDigest: value.checkpointDigest } : {}),
		...(approval ? { approval } : {}),
		...(completedPublication ? { completedPublication } : {}),
		...(typeof value.previousThemeName === "string" ? { previousThemeName: value.previousThemeName } : {}),
		...(Array.isArray(value.previousToolNames) ? { previousToolNames: [...value.previousToolNames] as string[] } : {}),
	};
}

export function planContentDigest(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

export function readPlanCheckpoint(value: unknown): PlanCheckpointDetails | undefined {
	if (!isRecord(value) || value.version !== PLAN_STATE_VERSION) return undefined;
	if (
		typeof value.ownerSessionId !== "string" || value.ownerSessionId.length === 0 ||
		typeof value.planId !== "string" || value.planId.length === 0 ||
		!isPositiveRevision(value.revision) ||
		!isDigest(value.digest) ||
		typeof value.content !== "string" ||
		value.content.length > MAX_PLAN_CHECKPOINT_CHARACTERS ||
		Buffer.byteLength(value.content, "utf8") > MAX_PLAN_CHECKPOINT_BYTES ||
		planContentDigest(value.content) !== value.digest
	) {
		return undefined;
	}
	return {
		version: PLAN_STATE_VERSION,
		ownerSessionId: value.ownerSessionId,
		planId: value.planId,
		revision: value.revision,
		digest: value.digest,
		content: value.content,
	};
}

export function createPlanCheckpoint(
	identity: PlanIdentity,
	current: PlanCheckpointDetails | undefined,
	content: string,
	expectedRevision: number,
): PlanCheckpointDetails {
	const currentRevision = current?.revision ?? 0;
	if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
		throw new Error("The expected plan revision must be a non-negative integer.");
	}
	if (expectedRevision !== currentRevision) {
		throw new Error(`Plan checkpoint conflict: expected revision ${currentRevision}, received ${expectedRevision}.`);
	}
	if (content.trim().length === 0) throw new Error("The full Markdown checkpoint must not be empty.");
	if (
		content.length > MAX_PLAN_CHECKPOINT_CHARACTERS ||
		Buffer.byteLength(content, "utf8") > MAX_PLAN_CHECKPOINT_BYTES
	) {
		throw new Error(`Plan checkpoint is too large; the limit is ${MAX_PLAN_CHECKPOINT_BYTES} UTF-8 bytes.`);
	}
	return {
		version: PLAN_STATE_VERSION,
		ownerSessionId: identity.ownerSessionId,
		planId: identity.planId,
		revision: currentRevision + 1,
		digest: planContentDigest(content),
		content,
	};
}

function customStateData(entry: unknown): unknown {
	if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== PLAN_STATE_ENTRY_TYPE) return undefined;
	return entry.data;
}

function checkpointFromEntry(entry: unknown): PlanCheckpointDetails | undefined {
	if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) return undefined;
	const message = entry.message;
	if (
		message.role !== "toolResult" ||
		message.toolName !== PLAN_CHECKPOINT_TOOL_NAME ||
		message.isError === true
	) {
		return undefined;
	}
	return readPlanCheckpoint(message.details);
}

export function reconstructPlanSession(
	allEntries: readonly unknown[],
	branchEntries: readonly unknown[],
	ownerSessionId: string,
): ReconstructedPlanSession {
	const rawStates = allEntries.map(customStateData).filter((data) => data !== undefined);
	const validStates = rawStates.map(readPlanLifecycleState).filter((state): state is PersistedPlanLifecycleState => state !== undefined);
	const ownedStates = validStates.filter((state) => state.ownerSessionId === ownerSessionId);
	const foreignState = validStates.some((state) => state.ownerSessionId !== ownerSessionId)
		|| allEntries.map(checkpointFromEntry).some((checkpoint) => checkpoint?.ownerSessionId !== undefined && checkpoint.ownerSessionId !== ownerSessionId);
	const legacyState = rawStates.some((state) => !isRecord(state) || state.version !== PLAN_STATE_VERSION);
	const invalidOwnedState = rawStates.some((raw) => {
		if (!isRecord(raw) || raw.version !== PLAN_STATE_VERSION || raw.ownerSessionId !== ownerSessionId) return false;
		return readPlanLifecycleState(raw) === undefined;
	});

	const planIds = new Set(ownedStates.map((state) => state.planId));
	if (planIds.size > 1) {
		return { foreignState, legacyState, issue: "multiple-plan-identities" };
	}
	const globalState = ownedStates.at(-1);
	if (!globalState) {
		return {
			foreignState,
			legacyState,
			...(invalidOwnedState ? { issue: "invalid-state" as const } : {}),
		};
	}

	const branchStates = branchEntries
		.map(customStateData)
		.map(readPlanLifecycleState)
		.filter(
			(state): state is PersistedPlanLifecycleState =>
				state !== undefined && state.ownerSessionId === ownerSessionId && state.planId === globalState.planId,
		);
	const branchState = branchStates.at(-1);
	const state: PersistedPlanLifecycleState = {
		...globalState,
		active: branchState?.active ?? false,
	};
	delete state.approval;
	delete state.completedPublication;
	delete state.previousThemeName;
	delete state.previousToolNames;
	if (branchState?.approval) state.approval = { ...branchState.approval };
	const branchCompletedPublication = branchState?.completedPublication;
	if (
		branchCompletedPublication &&
		branchCompletedPublication.path === state.publishedPath &&
		branchCompletedPublication.revision === state.publishedRevision &&
		branchCompletedPublication.digest === state.publishedDigest
	) {
		state.completedPublication = { ...branchCompletedPublication };
	}
	if (branchState?.previousThemeName) state.previousThemeName = branchState.previousThemeName;
	// Older inactive entries discarded the snapshot. Recover it only from
	// this branch, never from the session-global state or a sibling branch.
	const toolState = branchStates.findLast((entry) => entry.previousToolNames !== undefined);
	if (toolState?.previousToolNames) state.previousToolNames = [...toolState.previousToolNames];

	const checkpoint = branchEntries
		.map(checkpointFromEntry)
		.filter(
			(value): value is PlanCheckpointDetails =>
				value !== undefined && value.ownerSessionId === ownerSessionId && value.planId === state.planId,
		)
		.at(-1);

	return {
		state,
		...(checkpoint ? { checkpoint } : {}),
		foreignState,
		legacyState,
		...(invalidOwnedState ? { issue: "invalid-state" as const } : {}),
	};
}
