import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";

const PLAN_ARGUMENTS: AutocompleteItem[] = [
	{ value: "save", label: "save", description: "Create or update the latest checkpoint; remain in Plan mode" },
	{ value: "preview", label: "preview", description: "Preview the latest checkpoint without publishing" },
	{ value: "exit", label: "exit", description: "Leave Plan mode with publishing and preservation choices" },
	{ value: "status", label: "status", description: "Show revision and publication status without an agent turn" },
	{ value: "help", label: "help", description: "Show Plan command usage" },
	{ value: "--help", label: "--help", description: "Alias for help" },
	{ value: "-h", label: "-h", description: "Alias for help" },
];

function planArgumentPrefix(textBeforeCursor: string): string | undefined {
	return /^\/plan\s+([^\s]*)$/.exec(textBeforeCursor)?.[1];
}

export function createPlanArgumentAutocompleteProvider(current: AutocompleteProvider): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const currentLine = lines[cursorLine] ?? "";
			const prefix = planArgumentPrefix(currentLine.slice(0, cursorCol));
			if (prefix === undefined) return current.getSuggestions(lines, cursorLine, cursorCol, options);

			const normalizedPrefix = prefix.toLowerCase();
			const items = PLAN_ARGUMENTS.filter((item) => item.value.startsWith(normalizedPrefix));
			if (items.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			return { prefix, items };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			const currentLine = lines[cursorLine] ?? "";
			if (planArgumentPrefix(currentLine.slice(0, cursorCol)) !== undefined) return true;
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}
