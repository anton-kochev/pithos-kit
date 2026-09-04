export type TranslationDirection = "input" | "output";
export type TranslationControlAction = "on" | "off" | "status" | "config";

export type TranslateCommand =
  | { type: "manual" }
  | { type: "control"; direction: TranslationDirection; action: TranslationControlAction }
  | { type: "help" }
  | { type: "error"; message: string };

export const TRANSLATE_CONTROL_ARGUMENTS = [
  "input-on",
  "input-off",
  "input-status",
  "input-config",
  "output-on",
  "output-off",
  "output-status",
  "output-config",
] as const;

export const TRANSLATE_HELP = `Usage: /translate [input-{on,off,status,config}|output-{on,off,status,config}|--help]

Without an argument, translate the latest completed assistant response into a manual translation card.

Input controls:
  input-on      Translate future interactive prompts into English
  input-off     Stop translating prompts
  input-status  Show input translation settings
  input-config  Choose the exact input translation model

Output controls:
  output-on      Enable automatic display-only assistant translation
  output-off     Disable automatic assistant translation
  output-status  Show output translation settings
  output-config  Choose the target language and exact output translation model

Options:
  --help, -h  Show this help`;

export function parseTranslateCommand(rawArgs: string): TranslateCommand {
  const argument = rawArgs.trim().toLowerCase();
  if (argument === "") return { type: "manual" };
  if (argument === "--help" || argument === "-h") return { type: "help" };
  const match = /^(input|output)-(on|off|status|config)$/.exec(argument);
  if (match) {
    return {
      type: "control",
      direction: match[1] as TranslationDirection,
      action: match[2] as TranslationControlAction,
    };
  }
  return { type: "error", message: `Unknown /translate argument: ${rawArgs.trim()}` };
}
