import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPithosLogger, type PithosLogger } from "./logging.ts";

type RuleAction = "confirm" | "block";
type RuleKind = "command" | "path";

type RawRule = {
	name?: unknown;
	pattern?: unknown;
	action?: unknown;
};

type GuardRule = {
	name: string;
	pattern: string;
	action: RuleAction;
	kind: RuleKind;
	source: "builtin" | "project";
	regex: RegExp;
};

type RawConfig = {
	rules: RawRule[];
	commands: RawRule[];
	paths: RawRule[];
};

type AegisState = {
	rules: GuardRule[];
	configPath: string;
	configExists: boolean;
	warnings: string[];
};

const CONFIG_FILE = join(".pi", "aegis.json");
const DEFAULT_COMMAND_RULES: RawRule[] = [];
const DEFAULT_PATH_RULES: RawRule[] = [
	{
		name: "protect Aegis config",
		pattern: "^\\.pi/aegis\\.json$",
		action: "confirm",
	},
];

export default function aegis(pi: ExtensionAPI) {
	const log = createPithosLogger();
	log.info("extension.register");
	let state: AegisState | undefined;
	let enabled = true;

	pi.on("session_start", async (event, ctx) => {
		state = loadState(ctx.cwd);
		enabled = restoreEnabled(ctx);
		log.info("session.start", { reason: event.reason, sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(), enabled, rules: state.rules.length, warnings: state.warnings.length });
		if (ctx.hasUI && state.warnings.length > 0) {
			ctx.ui.notify(formatWarnings(state), "warning");
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return undefined;
		log.debug("tool_call.inspect", { toolName: event.toolName });

		const current = state ?? loadState(ctx.cwd);
		state = current;

		if (event.toolName === "bash") {
			const command = commandFromInput(event.input);
			if (!command) return undefined;
			return guardValue(ctx, current, "command", command, "command", log);
		}

		if (event.toolName === "write" || event.toolName === "edit") {
			const path = pathFromInput(event.input, ctx.cwd);
			if (!path) return undefined;
			return guardValue(ctx, current, "path", path, `${event.toolName} path`, log);
		}

		return undefined;
	});

	pi.registerCommand("aegis", {
		description: "View, reload, and toggle Aegis command/path rules",
		handler: async (args, ctx) => {
			const command = (args ?? "").trim().toLowerCase();
			log.info("command.aegis", { action: command || "status", sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.() });
			if (!command || command === "status") {
				state = loadState(ctx.cwd);
				return emitText(ctx, formatStatus(state, enabled));
			}

			if (command === "help" || command === "--help" || command === "-h") {
				return emitText(ctx, AEGIS_HELP);
			}

			if (command === "list") {
				state = loadState(ctx.cwd);
				return emitText(ctx, formatRuleList(state, enabled));
			}

			if (command === "reload") {
				state = loadState(ctx.cwd);
				return emitText(ctx, `Reloaded Aegis rules.\n\n${formatStatus(state, enabled)}`, state.warnings.length > 0 ? "warning" : "info");
			}

			if (command === "toggle") {
				enabled = !enabled;
				persistEnabled(pi, enabled);
				return emitText(ctx, `Aegis is now ${enabled ? "enabled" : "disabled"}.`, enabled ? "info" : "warning");
			}

			return emitText(ctx, "Usage: /aegis [status|list|reload|toggle|help]", "warning");
		},
	});
}

const AEGIS_HELP = `Usage: /aegis [status|list|reload|toggle|help]

Aegis protects agent-run bash commands and agent file edits/writes using project rules from .pi/aegis.json.
It does not guard user-entered ! or !! shell commands.

Create .pi/aegis.json in your project, for example:

{
  "commands": [
    {
      "name": "git push",
      "pattern": "\\\\bgit\\\\s+push\\\\b",
      "action": "confirm"
    },
    {
      "name": "recursive remove",
      "pattern": "\\\\brm\\\\s+(-rf|-fr|--recursive)\\\\b",
      "action": "block"
    }
  ],
  "paths": [
    {
      "name": "protect .pi",
      "pattern": "(^|/)\\\\.pi(/|$)",
      "action": "confirm"
    }
  ]
}

Command rules may also be placed in a top-level "rules" array.

Rule fields:
- name: human-readable label shown in prompts/status output.
- pattern: JavaScript regular expression string matched case-insensitively.
  - command patterns match the full shell command.
  - path patterns match a normalized project-relative path such as .pi/settings.json.
- action: "confirm" or "block".

Commands:
- /aegis status  Show config path and rule count.
- /aegis list    Show effective rules.
- /aegis reload  Reload .pi/aegis.json from disk.
- /aegis toggle  Enable/disable Aegis for this session.
- /aegis help    Show this help.

Options:
- --help, -h      Show this help.`;

async function guardValue(
	ctx: ExtensionContext,
	state: AegisState,
	kind: RuleKind,
	value: string,
	label: string,
	log: PithosLogger,
): Promise<{ block: true; reason?: string } | undefined> {
	const matches = matchingRules(state.rules, kind, value);
	if (matches.length === 0) return undefined;

	const blockingRule = matches.find((rule) => rule.action === "block");
	if (blockingRule) {
		log.warn("guard.block", { kind, label, rule: blockingRule.name });
		return {
			block: true,
			reason: `Blocked by Aegis ${kind} rule "${blockingRule.name}"`,
		};
	}

	const ruleNames = matches.map((rule) => rule.name).join(", ");
	if (!ctx.hasUI) {
		log.warn("guard.confirmation_unavailable", { kind, label, rules: ruleNames });
		return {
			block: true,
			reason: `${capitalize(kind)} requires confirmation by Aegis rule "${ruleNames}", but no UI is available`,
		};
	}

	const choice = await ctx.ui.select(
		`Aegis\n\n${capitalize(kind)} rule${matches.length === 1 ? "" : "s"} matched: ${ruleNames}\n\n${label}: ${value}\n\nAllow this operation?`,
		["No", "Yes"],
	);

	if (choice !== "Yes") {
		log.warn("guard.declined", { kind, label, rules: ruleNames });
		return {
			block: true,
			reason: "Blocked by Aegis: user declined confirmation",
		};
	}

	log.info("guard.allowed", { kind, label, rules: ruleNames });
	return undefined;
}

function loadState(cwd: string): AegisState {
	const configPath = join(cwd, CONFIG_FILE);
	const warnings: string[] = [];
	const defaultCommandRules = compileRules(DEFAULT_COMMAND_RULES, "command", "builtin", warnings);
	const defaultPathRules = compileRules(DEFAULT_PATH_RULES, "path", "builtin", warnings);
	const projectConfig = loadProjectConfig(configPath, warnings);
	const projectCommandRules = compileRules([...projectConfig.rules, ...projectConfig.commands], "command", "project", warnings);
	const projectPathRules = compileRules(projectConfig.paths, "path", "project", warnings);
	return {
		rules: [...defaultCommandRules, ...defaultPathRules, ...projectCommandRules, ...projectPathRules],
		configPath,
		configExists: existsSync(configPath),
		warnings,
	};
}

function loadProjectConfig(configPath: string, warnings: string[]): RawConfig {
	const empty: RawConfig = { rules: [], commands: [], paths: [] };
	if (!existsSync(configPath)) return empty;

	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
		return {
			rules: readRuleArray(parsed, "rules", warnings),
			commands: readRuleArray(parsed, "commands", warnings),
			paths: readRuleArray(parsed, "paths", warnings),
		};
	} catch (error) {
		warnings.push(`Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
		return empty;
	}
}

function readRuleArray(parsed: Record<string, unknown>, field: keyof RawConfig, warnings: string[]): RawRule[] {
	const value = parsed[field];
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		warnings.push(`Project config field \`${field}\` must be an array; ignoring it.`);
		return [];
	}
	return value.filter((rule): rule is RawRule => {
		if (rule && typeof rule === "object") return true;
		warnings.push(`Ignoring invalid project ${field} rule: rule must be an object.`);
		return false;
	});
}

function compileRules(rawRules: RawRule[], kind: RuleKind, source: GuardRule["source"], warnings: string[]): GuardRule[] {
	const rules: GuardRule[] = [];
	for (const raw of rawRules) {
		const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : undefined;
		const pattern = typeof raw.pattern === "string" && raw.pattern.trim() ? raw.pattern.trim() : undefined;
		const action = normalizeAction(raw.action);

		if (!name || !pattern || !action) {
			warnings.push(`Ignoring invalid ${source} ${kind} rule${name ? ` "${name}"` : ""}: expected string name, string pattern, and action "confirm" or "block".`);
			continue;
		}

		try {
			rules.push({ name, pattern, action, kind, source, regex: new RegExp(pattern, "i") });
		} catch (error) {
			warnings.push(`Ignoring invalid ${source} ${kind} rule "${name}": ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return rules;
}

function normalizeAction(action: unknown): RuleAction | undefined {
	return action === "confirm" || action === "block" ? action : undefined;
}

function commandFromInput(input: unknown): string | null {
	if (!input || typeof input !== "object") return null;
	const command = (input as { command?: unknown }).command;
	return typeof command === "string" && command.trim() ? command : null;
}

function pathFromInput(input: unknown, cwd: string): string | null {
	if (!input || typeof input !== "object") return null;
	const path = (input as { path?: unknown }).path;
	if (typeof path !== "string" || !path.trim()) return null;
	return normalizeProjectPath(path, cwd);
}

function normalizeProjectPath(path: string, cwd: string): string {
	const cleaned = path.trim().replace(/^@/, "");
	const absolute = resolve(cwd, cleaned);
	const rel = relative(cwd, absolute) || ".";
	return rel.split(sep).join("/");
}

function matchingRules(rules: GuardRule[], kind: RuleKind, value: string): GuardRule[] {
	return rules.filter((rule) => rule.kind === kind && rule.regex.test(value));
}

function formatStatus(state: AegisState, enabled = true): string {
	const projectCount = state.rules.filter((rule) => rule.source === "project").length;
	const builtinCount = state.rules.filter((rule) => rule.source === "builtin").length;
	const commandCount = state.rules.filter((rule) => rule.kind === "command").length;
	const pathCount = state.rules.filter((rule) => rule.kind === "path").length;
	const lines = [
		`Aegis is ${enabled ? "enabled" : "disabled"}.`,
		`Config: ${state.configPath}${state.configExists ? "" : " (not found; no project rules loaded)"}`,
		`Rules: ${state.rules.length} total (${commandCount} command, ${pathCount} path; ${builtinCount} built-in, ${projectCount} project)`,
	];
	if (state.warnings.length > 0) lines.push("", formatWarnings(state));
	return lines.join("\n");
}

function formatRuleList(state: AegisState, enabled = true): string {
	const lines = [formatStatus(state, enabled), "", "Effective rules:"];
	if (state.rules.length === 0) {
		lines.push("- none");
		return lines.join("\n");
	}

	for (const rule of state.rules) {
		lines.push(`- [${rule.kind}:${rule.action}] ${rule.name} (${rule.source}): /${rule.pattern}/i`);
	}
	return lines.join("\n");
}

function formatWarnings(state: AegisState): string {
	return ["Aegis warnings:", ...state.warnings.map((warning) => `- ${warning}`)].join("\n");
}

function emitText(ctx: ExtensionCommandContext | ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): string {
	if (ctx.hasUI) ctx.ui.notify(text, level);
	else console.log(text);
	return text;
}

function restoreEnabled(ctx: ExtensionContext): boolean {
	for (const entry of [...ctx.sessionManager.getEntries()].reverse()) {
		if (entry.type !== "custom" || entry.customType !== "aegis-enabled") continue;
		const data = (entry as { data?: { enabled?: unknown } }).data;
		if (typeof data?.enabled === "boolean") return data.enabled;
	}
	return true;
}

function persistEnabled(pi: ExtensionAPI, enabled: boolean): void {
	pi.appendEntry("aegis-enabled", { enabled });
}

function capitalize(value: string): string {
	return value.slice(0, 1).toUpperCase() + value.slice(1);
}
