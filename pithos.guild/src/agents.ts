export const GUILD_ROLES = Object.freeze([
	"explorer",
	"architect",
	"coder",
	"reviewer",
] as const);

export type GuildRole = (typeof GUILD_ROLES)[number];

export const GUILD_PROFILES = Object.freeze([
	"general",
	"frontend",
	"angular",
	"typescript",
	"dotnet",
	"rust",
] as const);

export type GuildProfile = (typeof GUILD_PROFILES)[number];
export type GuildTarget = `${GuildRole}/${GuildProfile}`;

export function isGuildRole(value: unknown): value is GuildRole {
	return typeof value === "string" && (GUILD_ROLES as readonly string[]).includes(value);
}

export function isGuildProfile(value: unknown): value is GuildProfile {
	return typeof value === "string" && (GUILD_PROFILES as readonly string[]).includes(value);
}

export function createGuildTarget(role: GuildRole, profile: GuildProfile): GuildTarget {
	return `${role}/${profile}`;
}

export function isGuildTarget(value: unknown): value is GuildTarget {
	if (typeof value !== "string") return false;
	const parts = value.split("/");
	return parts.length === 2 && isGuildRole(parts[0]) && isGuildProfile(parts[1]);
}

export interface GuildRoleDefinition {
	readonly description: string;
	readonly tools: readonly string[];
}

export interface GuildProfileDefinition {
	readonly description: string;
	readonly expertise: string;
}

const CANONICAL_READ_ONLY_TOOLS = Object.freeze(["read", "grep", "find", "ls"] as const);
const CANONICAL_CODER_TOOLS = Object.freeze(["read", "grep", "find", "ls", "edit", "write", "bash"] as const);

export const GUILD_ROLE_DEFINITIONS = Object.freeze({
	explorer: Object.freeze({
		description: "Investigates repository evidence and reports scoped facts without changing the repository.",
		tools: CANONICAL_READ_ONLY_TOOLS,
	}),
	architect: Object.freeze({
		description: "Designs repository-grounded contracts, invariants, test plans, and implementation handoffs without changing the repository.",
		tools: CANONICAL_READ_ONLY_TOOLS,
	}),
	coder: Object.freeze({
		description: "Implements the smallest approved repository change with tests and verification.",
		tools: CANONICAL_CODER_TOOLS,
	}),
	reviewer: Object.freeze({
		description: "Reviews repository changes with severity-ranked evidence and a clear verdict without changing the repository.",
		tools: CANONICAL_READ_ONLY_TOOLS,
	}),
} satisfies Record<GuildRole, GuildRoleDefinition>);

export const GUILD_PROFILE_DEFINITIONS = Object.freeze({
	general: Object.freeze({
		description: "Technology-neutral software engineering guidance.",
		expertise: "Cross-cutting concerns in the languages and platforms evidenced by the repository.",
	}),
	frontend: Object.freeze({
		description: "Browser and user-interface engineering guidance.",
		expertise: "Components, state, rendering, accessibility, performance, and browser boundaries.",
	}),
	angular: Object.freeze({
		description: "Angular application engineering guidance.",
		expertise: "Angular components, templates, dependency injection, reactivity, forms, and testing.",
	}),
	typescript: Object.freeze({
		description: "TypeScript and JavaScript engineering guidance.",
		expertise: "Type modeling, runtime boundaries, modules, packages, asynchronous behavior, and framework integration.",
	}),
	dotnet: Object.freeze({
		description: ".NET and C# engineering guidance.",
		expertise: "Runtime and project boundaries, dependency injection, persistence, asynchronous behavior, and testing.",
	}),
	rust: Object.freeze({
		description: "Rust engineering guidance.",
		expertise: "Ownership, APIs, errors, concurrency, Cargo features, unsafe boundaries, and testing.",
	}),
} satisfies Record<GuildProfile, GuildProfileDefinition>);

export const GUILD_MEMBER_ALIASES = Object.freeze({
	"dotnet-architect": "architect/dotnet",
	"frontend-architect": "architect/frontend",
	"typescript-architect": "architect/typescript",
	"rust-architect": "architect/rust",
	"csharp-coder": "coder/dotnet",
	"angular-coder": "coder/angular",
	"typescript-coder": "coder/typescript",
	"rust-coder": "coder/rust",
	"code-reviewer": "reviewer/general",
} as const satisfies Record<string, GuildTarget>);

export type GuildMemberAlias = keyof typeof GUILD_MEMBER_ALIASES;

export function isGuildMemberAlias(value: unknown): value is GuildMemberAlias {
	return typeof value === "string" && Object.hasOwn(GUILD_MEMBER_ALIASES, value);
}

export function resolveGuildTarget(value: unknown): GuildTarget | undefined {
	if (isGuildTarget(value)) return value;
	return isGuildMemberAlias(value) ? GUILD_MEMBER_ALIASES[value] : undefined;
}
