import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BorderedLoader, VERSION, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveActivePiPackage, type ActivePiPackage } from "./active-pi.ts";
import { loadBundledCatalog } from "./bundled-catalog.ts";
import type { Catalog, CatalogPackage } from "./catalog.ts";
import { refreshCatalog, type RefreshedCatalog } from "./catalog-service.ts";
import { commitConfig, readConfigSnapshot, type ConfigSnapshot } from "./config-transaction.ts";
import { buildDiagnostics, type DiagnosticsReport } from "./diagnostics.ts";
import { DoctorTimingTracker, formatDoctorProgress, formatDoctorTiming, type DoctorTimingSnapshot } from "./doctor-diagnostics.ts";
import { registerAtlasFooter } from "./footer.ts";
import { parsePithosConfig, type ManagedPithosState } from "./pithos-config.ts";
import { isOfflineEnvironment, RegistryClient } from "./registry.ts";
import { observeRuntime, type ObservedRuntimePackage } from "./runtime.ts";
import { registerSessionNaming } from "./session-name.ts";
import { planModeState } from "./safety.ts";
import { runConfigWizard } from "./ui.ts";
import { createPithosLogger, errorMetadata } from "./logging.ts";

const MAX_OUTPUT_CHARS = 40_000;
const DOCTOR_STATUS_KEY = "atlas-doctor";
const DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS = 10_000;

export const ATLAS_HELP = `Pithos Atlas gives eligible new sessions readable 3–5-word session names after their first user message, configures reproducible toolchain, Pi, and package pins, and diagnoses the active environment.

Usage: /pithos [command]

Pithos commands:
  /pithos                  Open the interactive Atlas menu
  /pithos help             Show this help
  /pithos packages         List pithos-kit packages and capabilities
  /pithos versions         Check published versions (use --refresh to bypass the session cache)
  /pithos doctor           Diagnose Pi, package, runtime, and .pithos compatibility
  /pithos config           Manage toolchain, Pi, and pithos-kit pins interactively
  /pithos config validate  Validate .pithos without changing it
  /pithos patch footer status  Inspect the optional built-in-file footer fallback
  /pithos patch footer apply   Apply the optional built-in-file fallback (restart required)
  /pithos patch footer remove  Restore Pi's stock built-in footer (restart required)`;

export type AtlasCommand =
	| { action: "menu" }
	| { action: "help" }
	| { action: "packages" }
	| { action: "versions"; refresh: boolean }
	| { action: "doctor"; refresh: boolean }
	| { action: "config" }
	| { action: "config-validate" }
	| { action: "patch-menu" }
	| { action: "patch-footer"; operation: "status" | "apply" | "remove" };

export function parseAtlasCommand(args: string): AtlasCommand {
	const tokens = args.trim().split(/\s+/u).filter(Boolean);
	if (tokens.length === 0) return { action: "menu" };
	if (tokens.length === 1 && tokens[0] === "help") return { action: "help" };
	if (tokens.length === 1 && tokens[0] === "packages") return { action: "packages" };
	if ((tokens[0] === "versions" || tokens[0] === "doctor") && tokens.slice(1).every((token) => token === "--refresh")) {
		return { action: tokens[0], refresh: tokens.includes("--refresh") };
	}
	if (tokens.length === 1 && tokens[0] === "config") return { action: "config" };
	if (tokens.length === 2 && tokens[0] === "config" && tokens[1] === "validate") return { action: "config-validate" };
	if (
		tokens.length === 3
		&& tokens[0] === "patch"
		&& tokens[1] === "footer"
		&& (tokens[2] === "status" || tokens[2] === "apply" || tokens[2] === "remove")
	) {
		return { action: "patch-footer", operation: tokens[2] };
	}
	throw new Error(ATLAS_HELP);
}

const KEBAB_CASE_SESSION_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function toKebabCaseSessionName(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
		.replace(/[\u0300-\u036f]/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		|| "unnamed-session";
}

const RENAME_SESSION_PARAMETERS = Type.Object({
	name: Type.String({
		minLength: 1,
		maxLength: 120,
		pattern: KEBAB_CASE_SESSION_NAME_RE.source,
		description: "New lowercase kebab-case display name for the current Pi session",
	}),
});

const INFO_PARAMETERS = Type.Object({
	action: Type.Union([
		Type.Literal("catalog"),
		Type.Literal("versions"),
		Type.Literal("runtime"),
		Type.Literal("config"),
		Type.Literal("doctor"),
	], { description: "Read-only information to retrieve" }),
	package: Type.Optional(Type.String({ description: "Optional @pithos-kit package name" })),
	refresh: Type.Optional(Type.Boolean({ description: "Bypass successful session registry caches" })),
});

type RenameSessionRequest = { name: string };
type InfoRequest = { action: "catalog" | "versions" | "runtime" | "config" | "doctor"; package?: string; refresh?: boolean };

interface ConfigObservation {
	snapshot: ConfigSnapshot;
	state: ManagedPithosState;
}

type FooterPatchOperation = "status" | "apply" | "remove";
type FooterPatchStatus = "available" | "applied" | "unsupported";

export interface FooterPatchReport {
	patch: "footer";
	action: FooterPatchOperation;
	status: FooterPatchStatus;
	changed: boolean;
	packageDir: string;
	version: string;
	file: string;
	sourceDigest: string;
	restartRequired: boolean;
}

interface FooterPatchExpectation {
	version: string;
	digest: string;
}

export interface AtlasDependencies {
	activePiPackage?: ActivePiPackage;
	waitForIdleTimeoutMs?: number;
	runFooterPatch?: (
		operation: FooterPatchOperation,
		packageRoot: string,
		signal?: AbortSignal,
		expectation?: FooterPatchExpectation,
	) => Promise<FooterPatchReport>;
}

const FOOTER_PATCH_SCRIPT = fileURLToPath(new URL("../scripts/pi-footer-patch.mjs", import.meta.url));

function bounded(text: string): string {
	return text.length <= MAX_OUTPUT_CHARS ? text : `${text.slice(0, MAX_OUTPUT_CHARS)}\n... output truncated`;
}

function emitText(ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">, text: string, level: "info" | "warning" | "error" = "info"): void {
	const output = bounded(text);
	if (ctx.hasUI) ctx.ui.notify(output, level);
	else console.log(output);
}

async function readConfig(cwd: string): Promise<ConfigObservation> {
	const snapshot = await readConfigSnapshot(join(cwd, ".pithos"));
	return { snapshot, state: parsePithosConfig(snapshot.content).state };
}

function selectPackage<T extends { name: string }>(items: T[], packageName?: string): T[] {
	return packageName ? items.filter(({ name }) => name === packageName) : items;
}

function formatCatalog(packages: CatalogPackage[], runtime: ObservedRuntimePackage[]): string {
	const loaded = new Map(runtime.map((item) => [item.name, item]));
	return bounded([
		"pithos-kit packages",
		...packages.map((pkg) => {
			const observation = loaded.get(pkg.name);
			const status = observation ? `loaded${observation.version ? ` ${observation.version}` : ""}` : "not detected";
			const named = (items: Array<{ name: string; internal?: boolean }>) =>
				items.map(({ name, internal }) => `${name}${internal ? " (internal)" : ""}`).join(", ");
			const groups = [
				pkg.pithosKit.commands.length > 0 ? `commands: ${pkg.pithosKit.commands.map(({ name }) => `/${name}`).join(", ")}` : undefined,
				pkg.pithosKit.tools.length > 0 ? `tools: ${named(pkg.pithosKit.tools)}` : undefined,
				pkg.pithosKit.prompts.length > 0 ? `prompts: ${named(pkg.pithosKit.prompts)}` : undefined,
				pkg.pithosKit.skills.length > 0 ? `skills: ${named(pkg.pithosKit.skills)}` : undefined,
				pkg.pithosKit.themes.length > 0 ? `themes: ${named(pkg.pithosKit.themes)}` : undefined,
				pkg.pithosKit.agents.length > 0 ? `agents: ${named(pkg.pithosKit.agents)}` : undefined,
				pkg.pithosKit.configuration.length > 0
					? `configuration: ${pkg.pithosKit.configuration.map(({ kind, key }) => `${kind} ${key}`).join(", ")}`
					: undefined,
			].filter((line): line is string => !!line);
			return `${pkg.name}@${pkg.version} [${status}]\n  ${pkg.pithosKit.summary}${groups.length > 0 ? `\n  ${groups.join("\n  ")}` : ""}`;
		}),
	].join("\n"));
}

function formatVersions(catalog: Catalog, refreshed: RefreshedCatalog, activePiVersion: string): string {
	const latestByName = new Map(Object.entries(refreshed.publishedVersions).map(([name, versions]) => [name, versions[0]?.version]));
	const lines = catalog.packages.map((pkg) => {
		const latest = latestByName.get(pkg.name);
		return `${pkg.name}  bundled ${pkg.version}  latest ${latest ?? "unavailable"}`;
	});
	if (refreshed.piLatestVersion) lines.unshift(`Pi  active ${activePiVersion}  latest ${refreshed.piLatestVersion}`);
	else lines.unshift(`Pi  active ${activePiVersion}  latest unavailable`);
	if (refreshed.warnings.length > 0) lines.push(`Warnings: ${refreshed.warnings.join("; ")}`);
	return bounded(lines.join("\n"));
}

function formatConfig(state: ManagedPithosState, exists: boolean): string {
	const toolchains = Object.entries(state.toolchains).sort(([a], [b]) => a.localeCompare(b));
	const packages = Object.entries(state.packages).sort(([a], [b]) => a.localeCompare(b));
	return bounded([
		`.pithos: ${exists ? "valid" : "not present (Atlas can create it)"}`,
		"Configured toolchains:",
		...(toolchains.length > 0 ? toolchains.map(([name, version]) => `  ${name}: ${version}`) : ["  none"]),
		`Configured Pi: ${state.piVersion ?? "not set"}`,
		"Configured pithos-kit packages:",
		...(packages.length > 0 ? packages.map(([name, version]) => `  ${name}: npm:${version}`) : ["  none"]),
	].join("\n"));
}

function formatFooterPatch(report: FooterPatchReport): string {
	const label = report.status === "available"
		? "available (stock footer active)"
		: report.status === "applied"
			? "applied"
			: "unsupported for this Pi source";
	return [
		`Pi ${report.version} built-in footer fallback patch: ${label}`,
		`Target: ${report.file}`,
		...(report.restartRequired ? ["Restart Pi to use the changed footer."] : []),
	].join("\n");
}

async function waitForIdleOrTimeout(ctx: Pick<ExtensionCommandContext, "waitForIdle" | "signal">, timeoutMs: number): Promise<void> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let removeAbort: (() => void) | undefined;
	try {
		await Promise.race([
			ctx.waitForIdle(),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error("Atlas is waiting for Pi to become idle. Abort the current model run or try again after it finishes; no changes were made.")), timeoutMs);
				timeout.unref?.();
				if (ctx.signal) {
					const abort = () => reject(new Error("Atlas command cancelled; no changes were made."));
					ctx.signal.addEventListener("abort", abort, { once: true });
					removeAbort = () => ctx.signal?.removeEventListener("abort", abort);
					if (ctx.signal.aborted) abort();
				}
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
		removeAbort?.();
	}
}

function doctorErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.split(/\r?\n/u, 1)[0]?.slice(0, 300) || "Doctor failed";
}

function formatDoctorFailure(error: unknown, timing: DoctorTimingSnapshot): string {
	return `${doctorErrorMessage(error)}\n${formatDoctorTiming("Doctor timing", timing)}`;
}

function formatDoctor(report: DiagnosticsReport, warnings: string[], timing: DoctorTimingSnapshot): string {
	const lines = [
		`Pi active: ${report.activePiVersion}`,
		`Pi configured for rebuild: ${report.configuredPiVersion ?? "not set"}`,
		...report.packages.map((pkg) => [
			pkg.name,
			`bundled=${pkg.bundledVersion ?? "unknown"}`,
			`configured=${pkg.configuredVersion ?? "none"}`,
			`loaded=${pkg.loadedVersion ?? "not detected"}`,
			`latest=${pkg.latestVersion ?? "unavailable"}`,
			`recommended=${pkg.recommendedVersion ?? "none"}`,
			pkg.compatibleWithActivePi === false ? "ACTIVE PI INCOMPATIBLE" : undefined,
			pkg.compatibleWithConfiguredPi === false ? "CONFIGURED PI INCOMPATIBLE" : undefined,
		].filter(Boolean).join("  ")),
	];
	lines.push(formatDoctorTiming("Doctor timing", timing));
	if (warnings.length > 0) lines.push(`Registry warnings: ${warnings.join("; ")}`);
	return bounded(lines.join("\n"));
}

export function registerAtlas(pi: ExtensionAPI, dependencies: AtlasDependencies = {}): void {
	const log = createPithosLogger();
	log.info("extension.register");
	registerSessionNaming(pi);
	registerAtlasFooter(pi);

	const enforceKebabCaseSessionName = (name: string | undefined): void => {
		if (!name || KEBAB_CASE_SESSION_NAME_RE.test(name)) return;
		pi.setSessionName(toKebabCaseSessionName(name));
	};
	pi.on("session_info_changed", (event) => enforceKebabCaseSessionName(event.name));
	pi.on("session_start", () => enforceKebabCaseSessionName(pi.getSessionName()));

	pi.registerTool({
		name: "rename_session",
		label: "Rename Session",
		description: "Set a lowercase kebab-case display name for the current Pi session when the user explicitly asks for a rename.",
		promptSnippet: "Rename the current Pi session in lowercase kebab-case when explicitly requested",
		promptGuidelines: ["Use rename_session only when the user explicitly asks to name or rename the current Pi session, and always provide the name in lowercase kebab-case."],
		parameters: RENAME_SESSION_PARAMETERS,
		async execute(toolCallId, request: RenameSessionRequest) {
			const name = request.name.trim();
			log.info("tool.rename_session", { toolCallId });
			if (!KEBAB_CASE_SESSION_NAME_RE.test(name)) {
				throw new Error("Session name must use lowercase kebab-case");
			}
			pi.setSessionName(name);
			return {
				content: [{ type: "text", text: `Session renamed to: ${name}` }],
				details: { name },
			};
		},
	});

	const activePiPackage = dependencies.activePiPackage
		?? resolveActivePiPackage({ entrypoint: process.argv[1], fallbackVersion: VERSION });
	const activePiVersion = activePiPackage.version;
	const runFooterPatch = dependencies.runFooterPatch ?? (async (
		operation: FooterPatchOperation,
		packageRoot: string,
		signal?: AbortSignal,
		expectation?: FooterPatchExpectation,
	) => {
		const result = await pi.exec(process.execPath, [
			FOOTER_PATCH_SCRIPT,
			"footer",
			operation,
			"--pi-dir",
			packageRoot,
			...(expectation ? [
				"--expect-version",
				expectation.version,
				"--expect-digest",
				expectation.digest,
			] : []),
			"--json",
		], { signal, timeout: 10_000 });
		let report: FooterPatchReport | undefined;
		try {
			report = JSON.parse(result.stdout.trim()) as FooterPatchReport;
		} catch {
			// The structured diagnostic below includes bounded process output.
		}
		if (!report || (result.code !== 0 && report.status !== "unsupported")) {
			const diagnostic = result.stderr.trim() || result.stdout.trim() || `patch process exited with code ${result.code}`;
			throw new Error(`Atlas footer patch failed: ${bounded(diagnostic)}`);
		}
		return report;
	});
	const waitForIdleTimeoutMs = dependencies.waitForIdleTimeoutMs ?? DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS;
	const catalog = loadBundledCatalog();
	const registry = new RegistryClient({ offline: isOfflineEnvironment() });

	const runtime = () => observeRuntime(catalog.packages, pi.getCommands(), pi.getAllTools());
	const refreshed = (signal?: AbortSignal, refresh = false, includeVersionHistory = false) =>
		refreshCatalog(catalog, registry, { signal, refresh, includeVersionHistory });
	const doctor = async (
		cwd: string,
		signal?: AbortSignal,
		refresh = false,
		timing = new DoctorTimingTracker(),
	) => {
		const [config, registryState, runtimePackages] = await Promise.all([
			timing.measure("config", () => readConfig(cwd)),
			timing.measure("registry", () => refreshed(signal, refresh, true)),
			timing.measure("runtime", runtime),
		]);
		return {
			report: buildDiagnostics({
				activePiVersion,
				configuredPiVersion: config.state.piVersion,
				bundled: catalog.packages,
				publishedVersions: registryState.publishedVersions,
				configuredPackages: config.state.packages,
				runtimePackages,
			}),
			warnings: registryState.warnings,
			timing: timing.snapshot(),
		};
	};

	pi.registerTool({
		name: "pithos_info",
		label: "Pithos Info",
		description: "Read pithos-kit package, version, runtime, compatibility, and .pithos configuration information.",
		promptSnippet: "Inspect pithos-kit packages and configuration without changing files.",
		promptGuidelines: ["Use pithos_info only for read-only inspection. Configuration changes require the user's interactive /pithos config command."],
		parameters: INFO_PARAMETERS,
		async execute(toolCallId, request: InfoRequest, signal, _onUpdate, ctx) {
			const started = Date.now();
			log.info("tool.pithos_info.start", { toolCallId, action: request.action, package: request.package, refresh: request.refresh });
			try {
				if (request.action === "catalog") {
					const packages = selectPackage(catalog.packages, request.package);
					const observations = (await runtime()).filter(({ name }) => !request.package || name === request.package);
					return { content: [{ type: "text", text: formatCatalog(packages, observations) }], details: { packages, runtime: observations } };
				}
				if (request.action === "runtime") {
					const observations = selectPackage(await runtime(), request.package);
					return { content: [{ type: "text", text: bounded(JSON.stringify(observations, null, 2)) }], details: { runtime: observations } };
				}
				if (request.action === "config") {
					const config = await readConfig(ctx.cwd);
					return { content: [{ type: "text", text: formatConfig(config.state, config.snapshot.exists) }], details: { exists: config.snapshot.exists, state: config.state } };
				}
				if (request.action === "versions") {
					const state = await refreshed(signal, request.refresh);
					const packages = selectPackage(state.packages, request.package);
					return { content: [{ type: "text", text: formatVersions({ ...catalog, packages }, state, activePiVersion) }], details: { packages, piLatestVersion: state.piLatestVersion, warnings: state.warnings } };
				}
				const timing = new DoctorTimingTracker();
				try {
					const state = await doctor(ctx.cwd, signal, request.refresh, timing);
					return { content: [{ type: "text", text: formatDoctor(state.report, state.warnings, state.timing) }], details: state };
				} catch (error) {
					const message = doctorErrorMessage(error);
					const snapshot = timing.snapshot();
					return {
						content: [{ type: "text", text: formatDoctorFailure(error, snapshot) }],
						details: { error: message, timing: snapshot },
						isError: true,
					};
				}
			} catch (error) {
				log.error("tool.pithos_info.error", { toolCallId, durationMs: Date.now() - started, action: request.action, error: errorMetadata(error) });
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: bounded(message) }], details: { error: message }, isError: true };
			}
		},
	});

	const runCommand = async (command: AtlasCommand, ctx: ExtensionCommandContext): Promise<void> => {
		const started = Date.now();
		log.info("command.pithos.start", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(), action: command.action });
		try {
		if (command.action === "menu") {
			if (ctx.mode !== "tui") {
				emitText(ctx, ATLAS_HELP);
				return;
			}
			const choice = await ctx.ui.select("Pithos Atlas", ["About", "Doctor", "Configure", "Fallback Patches"]);
			const selected: Record<string, AtlasCommand> = {
				About: { action: "help" },
				Doctor: { action: "doctor", refresh: false },
				Configure: { action: "config" },
				"Fallback Patches": { action: "patch-menu" },
			};
			if (choice) await runCommand(selected[choice], ctx);
			return;
		}
		if (command.action === "help") {
			emitText(ctx, ATLAS_HELP);
			return;
		}
		if (command.action === "packages") {
			emitText(ctx, formatCatalog(catalog.packages, await runtime()));
			return;
		}
		if (command.action === "versions") {
			const state = await refreshed(ctx.signal, command.refresh);
			emitText(ctx, formatVersions(catalog, state, activePiVersion), state.warnings.length > 0 ? "warning" : "info");
			return;
		}
		if (command.action === "config-validate") {
			const config = await readConfig(ctx.cwd);
			emitText(ctx, formatConfig(config.state, config.snapshot.exists));
			return;
		}
		if (command.action === "doctor") {
			const timing = new DoctorTimingTracker();
			let state: Awaited<ReturnType<typeof doctor>>;
			try {
				if (ctx.mode === "tui" && ctx.hasUI) {
					type DoctorLoaderResult =
						| { state: Awaited<ReturnType<typeof doctor>> }
						| { error: unknown }
						| { cancelled: true };
					const result = await ctx.ui.custom<DoctorLoaderResult>((tui, theme, _keybindings, done) => {
						const loader = new BorderedLoader(tui, theme, "Diagnosing Pithos environment...");
						let settled = false;
						const finish = (value: DoctorLoaderResult) => {
							if (settled) return;
							settled = true;
							timing.onUpdate = undefined;
							ctx.ui.setStatus(DOCTOR_STATUS_KEY, undefined);
							done(value);
						};
						timing.onUpdate = (snapshot) => ctx.ui.setStatus(DOCTOR_STATUS_KEY, formatDoctorProgress(snapshot));
						ctx.ui.setStatus(DOCTOR_STATUS_KEY, formatDoctorProgress(timing.snapshot()));
						loader.onAbort = () => finish({ cancelled: true });
						void doctor(ctx.cwd, loader.signal, command.refresh, timing).then(
							(value) => finish({ state: value }),
							(error: unknown) => finish({ error }),
						);
						return loader;
					});
					if ("cancelled" in result) {
						emitText(ctx, formatDoctorTiming("Doctor cancelled", timing.snapshot()), "warning");
						return;
					}
					if ("error" in result) throw result.error;
					state = result.state;
				} else {
					state = await doctor(ctx.cwd, ctx.signal, command.refresh, timing);
				}
			} catch (error) {
				emitText(ctx, formatDoctorFailure(error, timing.snapshot()), "error");
				return;
			}
			emitText(ctx, formatDoctor(state.report, state.warnings, state.timing), state.warnings.length > 0 ? "warning" : "info");
			return;
		}
		if (command.action === "patch-menu") {
			if (!activePiPackage.root) {
				emitText(ctx, "Atlas could not resolve the active Pi package root; patches are unavailable.", "error");
				return;
			}
			const report = await runFooterPatch("status", activePiPackage.root, ctx.signal);
			const footerLabel = report.status === "available" ? "available" : report.status;
			const actionLabel = report.status === "available"
				? "Apply built-in footer fallback"
				: report.status === "applied"
					? "Remove built-in footer fallback"
					: undefined;
			const options = [`Built-in footer fallback · ${footerLabel}`, ...(actionLabel ? [actionLabel] : []), "Back"];
			const choice = await ctx.ui.select("Optional Footer Fallback", options);
			if (choice === options[0]) {
				emitText(ctx, formatFooterPatch(report), report.status === "unsupported" ? "warning" : "info");
			} else if (actionLabel && choice === actionLabel) {
				await runCommand({
					action: "patch-footer",
					operation: report.status === "available" ? "apply" : "remove",
				}, ctx);
			}
			return;
		}
		if (command.action === "patch-footer") {
			if (!activePiPackage.root) {
				emitText(ctx, "Atlas could not resolve the active Pi package root; the footer patch was not run.", "error");
				return;
			}
			if (command.operation === "status") {
				const report = await runFooterPatch("status", activePiPackage.root, ctx.signal);
				emitText(ctx, formatFooterPatch(report), report.status === "unsupported" ? "warning" : "info");
				return;
			}
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				emitText(ctx, "/pithos patch footer apply/remove requires an interactive TUI.", "error");
				return;
			}
			await waitForIdleOrTimeout(ctx, waitForIdleTimeoutMs);
			if (planModeState(ctx.sessionManager.getBranch()) !== "inactive") {
				emitText(ctx, "/pithos patch footer is unavailable while Plan mode is active or indeterminate.", "error");
				return;
			}
			const before = await runFooterPatch("status", activePiPackage.root, ctx.signal);
			if (before.status === "unsupported") {
				emitText(ctx, formatFooterPatch(before), "error");
				return;
			}
			const desiredStatus = command.operation === "apply" ? "applied" : "available";
			if (before.status === desiredStatus) {
				emitText(ctx, `${formatFooterPatch(before)}\nNo change is needed.`);
				return;
			}
			const verb = command.operation === "apply" ? "Apply" : "Remove";
			const confirmed = await ctx.ui.confirm(
				`${verb} Atlas footer patch?`,
				`${verb} the minimal-footer patch in Pi ${before.version}?\n\nTarget: ${before.file}\n\nThe active Pi process will not change until it is restarted.`,
			);
			if (!confirmed) return;
			if (!(ctx.isIdle?.() ?? true) || planModeState(ctx.sessionManager.getBranch()) !== "inactive") {
				emitText(ctx, "Atlas safety state changed before footer patching; no change was made.", "error");
				return;
			}
			const report = await runFooterPatch(command.operation, activePiPackage.root, ctx.signal, {
				version: before.version,
				digest: before.sourceDigest,
			});
			emitText(ctx, formatFooterPatch(report), report.status === "unsupported" ? "error" : "info");
			return;
		}

		if (ctx.mode !== "tui" || !ctx.hasUI || !ctx.isProjectTrusted()) {
			emitText(ctx, "/pithos config requires a trusted interactive TUI.", "error");
			return;
		}
		await waitForIdleOrTimeout(ctx, waitForIdleTimeoutMs);
		if (planModeState(ctx.sessionManager.getBranch()) !== "inactive") {
			emitText(ctx, "/pithos config is unavailable while Plan mode is active or indeterminate.", "error");
			return;
		}

		try {
			const snapshot = await readConfigSnapshot(join(ctx.cwd, ".pithos"));
			parsePithosConfig(snapshot.content);
			const registryState = await refreshed(ctx.signal, false, true);
			if (registryState.warnings.length > 0) {
				ctx.ui.notify("Some registry data is unavailable; Atlas is using its bundled catalog where needed.", "warning");
			}
			const staged = await runConfigWizard(ctx.ui, {
				source: snapshot.content,
				activePiVersion,
				latestPiVersion: registryState.piLatestVersion,
				packages: registryState.packages,
				publishedVersions: registryState.publishedVersions,
			});
			if (!staged) return;
			const guard = () => {
				if (!ctx.isProjectTrusted() || !(ctx.isIdle?.() ?? true) || planModeState(ctx.sessionManager.getBranch()) !== "inactive") {
					throw new Error("Atlas safety state changed before commit; .pithos was not written");
				}
			};
			const changed = await commitConfig(snapshot, staged, undefined, guard);
			ctx.ui.notify(changed
				? "Updated .pithos. Rebuild/restart Pithos to use the new Pi and package pins."
				: "No .pithos changes were written.", "info");
		} catch (error) {
			emitText(ctx, error instanceof Error ? error.message : String(error), "error");
		}
			log.info("command.pithos.complete", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(), action: command.action, durationMs: Date.now() - started });
		} catch (error) {
			log.error("command.pithos.error", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(), action: command.action, durationMs: Date.now() - started, error: errorMetadata(error) });
			throw error;
		}
	};

	pi.registerCommand("pithos", {
		description: "Explore, diagnose, configure, and manage optional built-in fallback patches for Pithos",
		getArgumentCompletions(prefix) {
			const values = [
				"help",
				"packages",
				"versions",
				"versions --refresh",
				"doctor",
				"doctor --refresh",
				"config",
				"config validate",
				"patch footer status",
				"patch footer apply",
				"patch footer remove",
			];
			return values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
		},
		async handler(args, ctx) {
			try {
				await runCommand(parseAtlasCommand(args), ctx);
			} catch (error) {
				emitText(ctx, error instanceof Error ? error.message : ATLAS_HELP, "error");
			}
		},
	});
}
