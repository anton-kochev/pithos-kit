import { basename } from "node:path";
import type { RuntimeCommandInfo } from "./runtime.ts";

export interface InputOrderDiagnostic {
	status: "ok" | "warning" | "unknown" | "not-applicable";
	message: string;
}

export function diagnoseInputOrder(commands: RuntimeCommandInfo[]): InputOrderDiagnostic {
	const indices = (name: string) => commands.flatMap((command, index) => {
		const source = command.sourceInfo;
		const owned = source.source === `npm:@pithos-kit/${name}`
			|| source.source.startsWith(`npm:@pithos-kit/${name}@`)
			|| (source.baseDir && (source.source.startsWith("/") || source.source.startsWith("."))
				&& basename(source.source) === `pithos.${name}` && basename(source.baseDir) === `pithos.${name}`);
		return command.source === "extension" && command.name.split(":")[0] === name && owned ? [index] : [];
	});
	const squiggle = indices("squiggle");
	const translate = indices("translate");
	const commandCount = (name: string) => commands.filter((command) => command.source === "extension" && command.name.split(":")[0] === name).length;
	const squiggleCount = commandCount("squiggle");
	const translateCount = commandCount("translate");
	if (squiggleCount && translateCount && (squiggleCount !== 1 || translateCount !== 1 || !squiggle.length || !translate.length)) return {
		status: "unknown", message: "Input order unknown: Squiggle/Translate command ownership is ambiguous or could not be established from runtime provenance. Check the effective extension sources.",
	};
	if (!squiggle.length || !translate.length) return {
		status: "not-applicable", message: "Input order: both Squiggle and Translate were not detected as loaded; no ordering warning.",
	};
	// Infer handler order from unsorted command provenance. This relies on Pi
	// enumerating commands in extension load order; it is not an execution trace.
	if (squiggle[0] < translate[0]) return {
		status: "ok", message: "Input order: Squiggle before Translate (inferred from observed command order; toggle state is not exposed).",
	};
	return {
		status: "warning",
		message: "Input order warning: Translate appears before Squiggle in observed command order (inferred input-handler order). When both are enabled, load Squiggle before Translate so correction runs before translation. Check pi list and global/project .pi/settings.json packages and extensions, including CLI -e and auto-discovered extensions; reorder the effective sources, then restart Pi and rerun /pithos doctor. Atlas has not changed settings.",
	};
}
