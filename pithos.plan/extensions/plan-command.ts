export type PlanCommand =
	| { kind: "enter" }
	| { kind: "save" }
	| { kind: "preview" }
	| { kind: "exit" }
	| { kind: "status" }
	| { kind: "help" }
	| { kind: "unknown"; argument: string };

export const PLAN_COMMAND_HELP = `Usage: /plan
       /plan {save|preview|exit|status|help}

Commands:
  /plan          Enter Plan mode or restore this session's plan. If already active, this is a no-op.
  /plan save     Finalize/checkpoint and create or update the plan; remain in Plan mode.
  /plan preview  Preview the latest checkpoint without publishing it.
  /plan exit     Leave Plan mode, with a safe option to preserve without publishing.
  /plan status   Show mode, revision, publication state, and path without an agent turn.
  /plan help     Show this help. --help and -h are also accepted.

Task and refinement text belong in normal prompts after entering Plan mode.`;

const PLAN_SUBCOMMANDS = new Set(["save", "preview", "exit", "status"]);
const PLAN_HELP_ARGUMENTS = new Set(["help", "--help", "-h"]);

export function parsePlanCommand(input: string): PlanCommand | undefined {
	const text = input.trim();
	if (text === "/plan") return { kind: "enter" };
	if (!text.startsWith("/plan") || !/^\/plan\s/u.test(text)) return undefined;

	const argument = text.slice("/plan".length).trim();
	if (PLAN_HELP_ARGUMENTS.has(argument)) return { kind: "help" };
	if (PLAN_SUBCOMMANDS.has(argument)) return { kind: argument as "save" | "preview" | "exit" | "status" };
	return { kind: "unknown", argument };
}
