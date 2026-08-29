import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { PlanConfirmation, type PlanConfirmationDecision } from "./plan-confirmation.ts";
import { PlanPreview } from "./plan-preview.ts";

export type PlanCreationUI = {
	confirm: ExtensionUIContext["confirm"];
	select?: ExtensionUIContext["select"];
	custom?: ExtensionUIContext["custom"];
	notify?: ExtensionUIContext["notify"];
};

export type PlanCreationContext = {
	mode: "tui" | "rpc" | "json" | "print";
	hasUI: boolean;
	signal?: AbortSignal;
	ui: PlanCreationUI;
};

export type PlanCreationDecision = { action: "create" } | { action: "continue" };
export type PlanPublicationDecision = { action: "publish" } | { action: "continue" } | { action: "exit" };
export type PlanPublicationRequest = {
	workflow: "save" | "exit";
	kind: "create" | "update";
};
export type PlanExitWithoutCheckpointDecision =
	| { action: "exit" }
	| { action: "finalize" }
	| { action: "continue" };
export type PlanExitFallbackDecision = { action: "exit" } | { action: "continue" };

export async function confirmPlanExitWithoutCheckpoint(
	context: PlanCreationContext,
): Promise<PlanExitWithoutCheckpointDecision> {
	if (!context.hasUI || !context.ui.select) return { action: "exit" };
	const choice = await context.ui.select("Exit Plan mode — no checkpoint exists", [
		"Exit without publishing",
		"Finalize before exit",
		"Continue planning",
	], { signal: context.signal });
	if (choice === "Exit without publishing") return { action: "exit" };
	if (context.signal?.aborted) return { action: "continue" };
	if (choice === "Finalize before exit") return { action: "finalize" };
	if (choice === "Continue planning") return { action: "continue" };
	return { action: "exit" };
}

export async function confirmPlanExitFallback(
	context: PlanCreationContext,
): Promise<PlanExitFallbackDecision> {
	if (!context.hasUI || !context.ui.select) return { action: "exit" };
	const choice = await context.ui.select("Plan exit finalization did not publish", [
		"Exit without publishing",
		"Continue planning",
	], { signal: context.signal });
	if (choice === "Exit without publishing") return { action: "exit" };
	if (context.signal?.aborted || choice === "Continue planning") return { action: "continue" };
	return { action: "exit" };
}

function publicationLabel(kind: PlanPublicationRequest["kind"]): "Create plan" | "Update plan" {
	return kind === "update" ? "Update plan" : "Create plan";
}

function buildRpcReviewMessage(planPath: string, content: string, request: PlanPublicationRequest): string {
	return [
		`Target: \`${planPath}\``,
		"",
		`Review the exact plan checkpoint below. Approving will ${request.kind} this content atomically${
			request.workflow === "exit" ? " and exit Plan mode after publication succeeds" : " while Plan mode remains active"
		}.`,
		"",
		"--- exact plan checkpoint ---",
		content,
		"--- end exact plan checkpoint ---",
	].join("\n");
}

function buildRpcPreviewMessage(planPath: string, content: string): string {
	return [
		`Target: \`${planPath}\``,
		"",
		"Review-only preview. Closing this dialog does not approve, reject, publish, or exit.",
		"",
		"--- exact plan checkpoint ---",
		content,
		"--- end exact plan checkpoint ---",
	].join("\n");
}

function bindAbortCompletion<T>(
	signal: AbortSignal | undefined,
	done: (result: T) => void,
	abortedResult: T,
): { complete: (result: T) => void; cleanup: () => void } {
	let completed = false;
	const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
	const complete = (result: T): void => {
		if (completed) return;
		completed = true;
		cleanup();
		done(result);
	};
	const onAbort = (): void => {
		queueMicrotask(() => complete(abortedResult));
	};
	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	}
	return { complete, cleanup };
}

async function showPlanConfirmation(
	custom: NonNullable<PlanCreationUI["custom"]>,
	planPath: string,
	request: PlanPublicationRequest,
	signal?: AbortSignal,
): Promise<PlanConfirmationDecision> {
	let cleanup = (): void => {};
	try {
		return await custom<PlanConfirmationDecision>((tui, theme, keybindings, done) => {
			const completion = bindAbortCompletion(signal, done, "continue");
			cleanup = completion.cleanup;
			return new PlanConfirmation({
				planPath,
				terminalRows: () => tui.terminal.rows,
				theme,
				keybindings,
				onDecision: completion.complete,
				onRender: () => tui.requestRender(),
				workflow: request.workflow,
				publicationAction: publicationLabel(request.kind),
			});
		});
	} finally {
		cleanup();
	}
}

async function showPlanPreview(
	custom: NonNullable<PlanCreationUI["custom"]>,
	planPath: string,
	content: string,
	signal?: AbortSignal,
): Promise<void> {
	let cleanup = (): void => {};
	try {
		await custom<void>((tui, theme, keybindings, done) => {
			const completion = bindAbortCompletion(signal, done, undefined);
			cleanup = completion.cleanup;
			return new PlanPreview({
				content,
				planPath,
				terminalRows: () => tui.terminal.rows,
				theme,
				keybindings,
				onClose: () => completion.complete(undefined),
				onRender: () => tui.requestRender(),
			});
		});
	} finally {
		cleanup();
	}
}

export async function previewPlanCheckpoint(
	context: PlanCreationContext,
	planPath: string,
	content: string,
): Promise<boolean> {
	if (context.mode === "tui" && context.ui.custom) {
		await showPlanPreview(context.ui.custom, planPath, content, context.signal);
		return true;
	}
	if (context.hasUI && context.ui.notify) {
		context.ui.notify(`Plan checkpoint preview\nTarget: ${planPath}\n\n${content}`, "info");
		return true;
	}
	return false;
}

async function confirmRpcPublication(
	context: PlanCreationContext,
	planPath: string,
	content: string,
	request: PlanPublicationRequest,
): Promise<PlanPublicationDecision> {
	if (request.workflow === "save") {
		const approved = await context.ui.confirm(
			"Review plan draft",
			buildRpcReviewMessage(planPath, content, request),
			{ signal: context.signal },
		);
		return approved && !context.signal?.aborted
			? { action: "publish" }
			: { action: "continue" };
	}

	if (!context.ui.select) return { action: "exit" };
	while (true) {
		const label = publicationLabel(request.kind);
		const choice = await context.ui.select("Exit Plan mode — what next?", [
			"Exit without publishing",
			label,
			"Preview the plan",
			"Continue planning",
		], { signal: context.signal });
		if (choice === "Exit without publishing") return { action: "exit" };
		if (context.signal?.aborted) return { action: "continue" };
		if (choice === label) {
			const approved = await context.ui.confirm(
				`Review ${label.toLowerCase()}`,
				buildRpcReviewMessage(planPath, content, request),
				{ signal: context.signal },
			);
			return approved && !context.signal?.aborted
				? { action: "publish" }
				: { action: "continue" };
		}
		if (choice === "Preview the plan") {
			await context.ui.confirm(
				"Plan checkpoint preview (review only)",
				buildRpcPreviewMessage(planPath, content),
				{ signal: context.signal },
			);
			if (context.signal?.aborted) return { action: "continue" };
			continue;
		}
		if (choice === "Continue planning") return { action: "continue" };
		return { action: "exit" };
	}
}

export async function confirmPlanPublication(
	context: PlanCreationContext,
	planPath: string,
	content: string,
	request: PlanPublicationRequest,
): Promise<PlanPublicationDecision> {
	if (!context.hasUI) return request.workflow === "exit" ? { action: "exit" } : { action: "continue" };

	if (context.mode === "tui" && context.ui.custom) {
		while (true) {
			const decision = await showPlanConfirmation(context.ui.custom, planPath, request, context.signal);
			if (decision === "preview") {
				await showPlanPreview(context.ui.custom, planPath, content, context.signal);
				if (context.signal?.aborted) return { action: "continue" };
				continue;
			}
			if (decision === "create") return { action: "publish" };
			if (decision === "exit") return { action: "exit" };
			return { action: "continue" };
		}
	}

	if (context.mode === "rpc") return confirmRpcPublication(context, planPath, content, request);
	return request.workflow === "exit" ? { action: "exit" } : { action: "continue" };
}

export async function confirmPlanCreation(
	context: PlanCreationContext,
	planPath: string,
	content: string,
): Promise<PlanCreationDecision> {
	const decision = await confirmPlanPublication(context, planPath, content, {
		workflow: "save",
		kind: "create",
	});
	return decision.action === "publish" ? { action: "create" } : { action: "continue" };
}
