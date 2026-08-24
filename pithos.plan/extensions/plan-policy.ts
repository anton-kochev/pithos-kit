import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type PlanToolInfo = {
	name: string;
	sourceInfo: {
		source: string;
		path: string;
		scope?: string;
		origin?: string;
		baseDir?: string;
	};
};

export const PLAN_CREATE_TOOL_NAME = "create_plan";

const PLAN_READ_TOOL_NAMES: readonly string[] = ["read", "grep", "find", "ls"];
const PLAN_WEB_TOOL_NAMES: readonly string[] = ["web_search", "web_fetch"];
const PITHOS_WEB_PACKAGE_NAME = "@pithos-kit/web";

export function isTrustedBuiltinTool(tools: PlanToolInfo[], name: string): boolean {
	return tools.some(
		(tool) =>
			tool.name === name && tool.sourceInfo.source === "builtin" && tool.sourceInfo.path === `<builtin:${name}>`,
	);
}

function pathIsInside(parent: string, candidate: string): boolean {
	const child = relative(parent, candidate);
	return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function sourceMatchesWebPackage(source: string, packageRoot: string): boolean {
	if (/^npm:@pithos-kit\/web(?:@[^\s]+)?$/u.test(source)) return true;
	if (/^(?:npm|git|https?|ssh):/u.test(source)) return false;
	return basename(packageRoot) === "pithos.web"
		&& basename(source.replace(/[\\/]+$/u, "")) === "pithos.web";
}

function manifestIdentifiesWebPackage(packageRoot: string): boolean {
	try {
		const manifestPath = join(packageRoot, "package.json");
		if (!statSync(manifestPath).isFile()) return false;
		const canonicalManifest = realpathSync(manifestPath);
		if (dirname(canonicalManifest) !== packageRoot) return false;
		const manifest = JSON.parse(readFileSync(canonicalManifest, "utf8")) as {
			name?: unknown;
			pi?: { extensions?: unknown };
		};
		return manifest.name === PITHOS_WEB_PACKAGE_NAME
			&& Array.isArray(manifest.pi?.extensions)
			&& manifest.pi.extensions.some((entry) => entry === "./extensions" || entry === "extensions");
	} catch {
		return false;
	}
}

export function isTrustedPlanWebTool(tools: PlanToolInfo[], name: string): boolean {
	if (!PLAN_WEB_TOOL_NAMES.includes(name)) return false;
	return tools.some((tool) => {
		if (tool.name !== name || tool.sourceInfo.origin !== "package" || !tool.sourceInfo.baseDir) return false;
		try {
			const packageRoot = realpathSync(tool.sourceInfo.baseDir);
			const extensionPath = realpathSync(tool.sourceInfo.path);
			return pathIsInside(packageRoot, extensionPath)
				&& sourceMatchesWebPackage(tool.sourceInfo.source, packageRoot)
				&& manifestIdentifiesWebPackage(packageRoot);
		} catch {
			return false;
		}
	});
}

export function isTrustedPlanReadTool(tools: PlanToolInfo[], name: string): boolean {
	return (PLAN_READ_TOOL_NAMES.includes(name) && isTrustedBuiltinTool(tools, name))
		|| isTrustedPlanWebTool(tools, name);
}

export function isTrustedPlanCreationTool(
	tools: PlanToolInfo[],
	name: string,
	planExtensionPath: string,
): boolean {
	return (
		name === PLAN_CREATE_TOOL_NAME &&
		tools.some(
			(tool) => tool.name === name && resolve(tool.sourceInfo.path) === resolve(planExtensionPath),
		)
	);
}

export function selectPlanModeTools(tools: PlanToolInfo[], planExtensionPath: string): string[] {
	const selected = PLAN_READ_TOOL_NAMES.filter((name) => isTrustedBuiltinTool(tools, name));
	selected.push(...PLAN_WEB_TOOL_NAMES.filter((name) => isTrustedPlanWebTool(tools, name)));
	if (isTrustedPlanCreationTool(tools, PLAN_CREATE_TOOL_NAME, planExtensionPath)) {
		selected.push(PLAN_CREATE_TOOL_NAME);
	}
	return selected;
}
