import { spawn } from "node:child_process";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

// Read-only git inspection for the roles without shell access. Reviewers were asked to review
// uncommitted changes they could not see. Options are an exact allowlist: git accepts
// abbreviated long options (`--out=` for `--output=`), so a blocklist cannot be trusted.
// Never changes staged content, refs or the working tree. Like any plain `git diff`, diff may
// still refresh the index stat cache, and repository-configured clean filters still run.

export const GIT_READ_TOOL = "git_read";
export const GIT_READ_LIMITS = Object.freeze({ output: 50 * 1024, args: 64, arg: 1024, timeoutMs: 30_000 });

const SUBCOMMANDS = ["status", "diff", "log", "show", "ls-files", "blame"] as const;
export type GitReadSubcommand = (typeof SUBCOMMANDS)[number];

interface OptionRules {
	/** Options accepted exactly as written. */
	flags: readonly string[];
	/** Long options accepted only in `--name=value` form. */
	values: readonly string[];
	/** Short options with an attached value, such as `-U5` or `-n20`. */
	attached: readonly RegExp[];
}

const DIFF_FORMAT: OptionRules = {
	flags: ["-p", "--patch", "-s", "--no-patch", "--stat", "--numstat", "--shortstat", "--dirstat", "--summary", "--name-only", "--name-status",
		"--raw", "--check", "-w", "--ignore-all-space", "-b", "--ignore-space-change", "--ignore-blank-lines", "-M", "--find-renames",
		"--no-renames", "-R", "--full-index", "--minimal", "--patience", "--histogram", "--word-diff", "--relative", "--no-color"],
	values: ["--unified", "--stat", "--dirstat", "--diff-filter", "--find-renames", "--word-diff", "--relative", "--diff-algorithm"],
	attached: [/^-U\d+$/, /^-M\d+%?$/],
};

const HISTORY: OptionRules = {
	flags: ["-n", "--oneline", "--graph", "--decorate", "--no-decorate", "--all", "--branches", "--tags", "--first-parent", "--no-merges",
		"--merges", "--reverse", "--follow", "--date-order", "--topo-order", "--abbrev-commit", "--source", "--left-right", "--cherry-pick",
		"--boundary", "-i", "--regexp-ignore-case", "--all-match", "--invert-grep", "-S", "-G"],
	values: ["--max-count", "--skip", "--since", "--after", "--until", "--before", "--author", "--committer", "--grep", "--format", "--pretty",
		"--date", "--decorate", "--abbrev", "--branches", "--tags"],
	attached: [/^-n\d+$/, /^-\d+$/, /^-[SG].+$/, /^-L.+$/],
};

function merge(...rules: OptionRules[]): OptionRules {
	return { flags: rules.flatMap(rule => rule.flags), values: rules.flatMap(rule => rule.values), attached: rules.flatMap(rule => rule.attached) };
}

const RULES: Record<GitReadSubcommand, OptionRules> = {
	status: {
		flags: ["-s", "--short", "-b", "--branch", "--porcelain", "--long", "--ignored", "--ahead-behind", "--no-ahead-behind", "--renames", "--no-renames"],
		values: ["--porcelain", "--untracked-files", "--ignored"],
		attached: [/^-u(no|normal|all)?$/],
	},
	diff: merge(DIFF_FORMAT, { flags: ["--cached", "--staged", "--merge-base"], values: [], attached: [] }),
	log: merge(DIFF_FORMAT, HISTORY),
	show: merge(DIFF_FORMAT, HISTORY),
	"ls-files": {
		flags: ["-c", "--cached", "-d", "--deleted", "-m", "--modified", "-o", "--others", "-i", "--ignored", "-s", "--stage", "-u", "--unmerged",
			"--directory", "--exclude-standard", "--full-name", "--error-unmatch", "--eol", "--deduplicate"],
		values: ["--exclude", "--format"],
		attached: [],
	},
	blame: {
		flags: ["-w", "-M", "-C", "-s", "-e", "--show-email", "-l", "-t", "-f", "--show-name", "-n", "--show-number", "--porcelain", "--line-porcelain", "--root", "-L"],
		values: ["--date", "--abbrev"],
		attached: [/^-[MC]\d+$/, /^-L.+$/],
	},
};

/** Forced before user options: no external diff programs or textconv filters. */
const FORCED: Partial<Record<GitReadSubcommand, readonly string[]>> = {
	diff: ["--no-ext-diff", "--no-textconv", "--no-color"],
	log: ["--no-ext-diff", "--no-textconv", "--no-color"],
	show: ["--no-ext-diff", "--no-textconv", "--no-color"],
	blame: ["--no-textconv"],
};

export const gitReadParameters = Type.Object({
	subcommand: StringEnum(SUBCOMMANDS),
	args: Type.Optional(Type.Array(Type.String({ maxLength: GIT_READ_LIMITS.arg }), { maxItems: GIT_READ_LIMITS.args })),
}, { additionalProperties: false });

export type GitReadInput = Static<typeof gitReadParameters>;

/** Full git argv for an allowed request; throws with the offending argument otherwise. */
export function buildGitReadArguments(subcommand: GitReadSubcommand, args: readonly string[] = []): string[] {
	const rules = RULES[subcommand];
	if (!rules) throw new Error(`Unsupported git_read subcommand: ${String(subcommand)}`);
	if (args.length > GIT_READ_LIMITS.args) throw new Error("Too many git_read arguments");
	let paths = false;
	for (const arg of args) {
		if (typeof arg !== "string" || arg.includes("\0") || Buffer.byteLength(arg) > GIT_READ_LIMITS.arg) throw new Error("Invalid git_read argument");
		if (paths || !arg.startsWith("-")) continue;
		if (arg === "--") { paths = true; continue; }
		const equals = arg.indexOf("=");
		const allowed = equals > 0
			? arg.startsWith("--") && rules.values.includes(arg.slice(0, equals))
			: rules.flags.includes(arg) || rules.attached.some(pattern => pattern.test(arg));
		if (!allowed) throw new Error(`git_read does not allow option ${JSON.stringify(arg)} for ${subcommand}; put paths after "--"`);
		// %G placeholders verify signatures, which runs the configured gpg.program.
		if (/^--(format|pretty)=/.test(arg) && arg.includes("%G")) throw new Error("git_read does not allow signature placeholders (%G)");
	}
	return [
		"--no-pager", "-c", "core.fsmonitor=false", "-c", "log.showSignature=false", "-c", "core.quotepath=off", "-c", "color.ui=never",
		subcommand, ...(FORCED[subcommand] ?? []), ...args,
	];
}

/** Keeps whole lines within the output cap and says how much was left out. */
export function capGitOutput(output: Buffer, overflowed: boolean): string {
	const limit = GIT_READ_LIMITS.output;
	if (output.length <= limit && !overflowed) return output.toString("utf8");
	const head = output.subarray(0, limit);
	const lastNewline = head.lastIndexOf(10);
	const kept = lastNewline > 0 ? head.subarray(0, lastNewline + 1) : head;
	return `${kept.toString("utf8")}\n[git_read output truncated at ${limit} bytes. Narrow it with paths after "--", --stat, --name-only or -n.]`;
}

export function runGitRead(cwd: string, input: GitReadInput, signal?: AbortSignal): Promise<string> {
	const argv = buildGitReadArguments(input.subcommand, input.args ?? []);
	return new Promise((resolve, reject) => {
		const { GIT_EXTERNAL_DIFF: _external, ...inherited } = process.env;
		const env = { ...inherited, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: "0" };
		const child = spawn("git", argv, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env, windowsHide: true });
		const stdout: Buffer[] = [];
		let stdoutBytes = 0;
		let overflowed = false;
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), GIT_READ_LIMITS.timeoutMs);
		timer.unref?.();
		const abort = () => child.kill("SIGKILL");
		signal?.addEventListener("abort", abort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			if (overflowed) return;
			stdout.push(chunk);
			stdoutBytes += chunk.length;
			// One byte past the cap proves truncation; the rest is never read.
			if (stdoutBytes > GIT_READ_LIMITS.output) { overflowed = true; child.kill("SIGKILL"); }
		});
		child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString("utf8"); });
		child.on("error", error => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(error); });
		child.on("close", (code, killedBy) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			if (signal?.aborted) return reject(new Error("git_read cancelled"));
			if (!overflowed && (code !== 0 || killedBy)) {
				return reject(new Error(`git ${input.subcommand} failed${killedBy ? ` (${killedBy})` : ` with exit ${code}`}: ${stderr.trim().slice(0, 2048) || "no error output"}`));
			}
			const text = capGitOutput(Buffer.concat(stdout), overflowed);
			resolve(text.trim() ? text : "(no output)");
		});
	});
}

export function registerGitReadTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: GIT_READ_TOOL,
		label: "Read git state",
		description: [
			"Read-only git inspection: status, diff, log, show, ls-files and blame in the working directory.",
			"Pass the subcommand and its arguments separately, e.g. {subcommand: \"diff\", args: [\"--stat\", \"HEAD\"]}.",
			"Only common read-only options are accepted, spelled in full; long options take values as --name=value. Put paths after \"--\".",
			`Output is capped at ${GIT_READ_LIMITS.output / 1024} KiB; narrow large diffs with paths, --stat or --name-only.`,
		].join(" "),
		parameters: gitReadParameters,
		async execute(_id, params, signal, _update, ctx) {
			const text = await runGitRead(ctx.cwd, params, signal);
			return { content: [{ type: "text", text }], details: { subcommand: params.subcommand } };
		},
	});
}
