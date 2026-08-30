import "./runtime-compat.ts";
import { createHash, randomUUID } from "node:crypto";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
	renameSync,
} from "node:fs";
import { link, lstat, mkdir, open, realpath, rm, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { MAX_PLAN_CHECKPOINT_BYTES } from "./plan-state.ts";

const MAX_PLAN_NAME_LENGTH = 64;
const PLAN_CONFIG_DIRECTORY = ".pi";
const PLANS_DIRECTORY = "plans";

export class PlanPathSafetyError extends Error {
	readonly code = "PLAN_PATH_UNSAFE";

	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "PlanPathSafetyError";
	}
}

export class PlanPublicationConflictError extends Error {
	readonly code = "PLAN_PUBLICATION_CONFLICT";

	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "PlanPublicationConflictError";
	}
}

function contentDigest(content: string | Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

type CanonicalPlanLocation = {
	canonicalCwd: string;
	configDirectory: string;
	plansDirectory: string;
	absolutePath: string;
};

function unsafePlanPath(message: string, cause?: unknown): PlanPathSafetyError {
	return new PlanPathSafetyError(
		message,
		cause === undefined ? undefined : { cause },
	);
}

function planFilename(planPath: string): string {
	if (planPath.includes("\0")) {
		throw unsafePlanPath("Plan publication paths must stay inside .pi/plans");
	}
	const normalized = planPath.replaceAll("\\", "/");
	const match = /^\.pi\/plans\/([^/]+\.md)$/u.exec(normalized);
	if (!match?.[1] || match[1] === ".md") {
		throw unsafePlanPath("Plan publication paths must be project-relative files inside .pi/plans");
	}
	return match[1];
}

async function canonicalizeCwd(cwd: string): Promise<string> {
	try {
		const canonicalCwd = await realpath(cwd);
		const stat = await lstat(canonicalCwd);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw unsafePlanPath("Plan publication requires cwd to resolve to a safe directory");
		}
		return canonicalCwd;
	} catch (error) {
		if (error instanceof PlanPathSafetyError) throw error;
		throw unsafePlanPath("Plan publication requires cwd to resolve to a safe directory", error);
	}
}

async function validateExistingDirectory(path: string, label: string): Promise<boolean> {
	let stat;
	try {
		stat = await lstat(path);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return false;
		}
		throw unsafePlanPath(`${label} must be a safe directory`, error);
	}
	if (stat.isSymbolicLink()) {
		throw unsafePlanPath(`${label} must be a real directory, not a symbolic link`);
	}
	if (!stat.isDirectory()) throw unsafePlanPath(`${label} must be a safe directory`);
	try {
		if (await realpath(path) !== path) {
			throw unsafePlanPath(`${label} must resolve within the canonical project directory`);
		}
	} catch (error) {
		if (error instanceof PlanPathSafetyError) throw error;
		throw unsafePlanPath(`${label} could not be validated as a safe directory`, error);
	}
	return true;
}

async function validateExistingPlanParents(
	location: CanonicalPlanLocation,
	requireExisting: boolean,
): Promise<void> {
	const configExists = await validateExistingDirectory(location.configDirectory, ".pi");
	if (!configExists) {
		if (requireExisting) throw unsafePlanPath(".pi must be an existing safe directory");
		return;
	}
	const plansExists = await validateExistingDirectory(location.plansDirectory, ".pi/plans");
	if (!plansExists && requireExisting) {
		throw unsafePlanPath(".pi/plans must be an existing safe directory");
	}
}

async function canonicalPlanLocation(
	cwd: string,
	planPath: string,
	requireExistingParents: boolean,
): Promise<CanonicalPlanLocation> {
	const filename = planFilename(planPath);
	const canonicalCwd = await canonicalizeCwd(cwd);
	const configDirectory = join(canonicalCwd, PLAN_CONFIG_DIRECTORY);
	const plansDirectory = join(configDirectory, PLANS_DIRECTORY);
	const location = {
		canonicalCwd,
		configDirectory,
		plansDirectory,
		absolutePath: join(plansDirectory, filename),
	};
	await validateExistingPlanParents(location, requireExistingParents);
	return location;
}

async function ensureDirectory(path: string, label: string): Promise<void> {
	try {
		await mkdir(path);
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) {
			throw unsafePlanPath(`${label} could not be created safely`, error);
		}
	}
	if (!(await validateExistingDirectory(path, label))) {
		throw unsafePlanPath(`${label} could not be created safely`);
	}
}

function validateExistingDirectorySync(path: string, label: string): void {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) {
			throw unsafePlanPath(`${label} must be a real directory, not a symbolic link`);
		}
		if (!stat.isDirectory()) throw unsafePlanPath(`${label} must be a safe directory`);
		if (realpathSync(path) !== path) {
			throw unsafePlanPath(`${label} must resolve within the canonical project directory`);
		}
	} catch (error) {
		if (error instanceof PlanPathSafetyError) throw error;
		throw unsafePlanPath(`${label} must be an existing safe directory`, error);
	}
}

function validateExistingPlanParentsSync(location: CanonicalPlanLocation): void {
	validateExistingDirectorySync(location.configDirectory, ".pi");
	validateExistingDirectorySync(location.plansDirectory, ".pi/plans");
}

function slugifyTask(task: string): string {
	return task
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_PLAN_NAME_LENGTH)
		.replace(/-+$/g, "");
}

async function pathEntryExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

function formatTimestamp(date: Date): string {
	return date.toISOString().slice(0, 19).replace("T", "-").replace(/:/g, "");
}

export async function generatePlanPath(
	cwd: string,
	configDirectoryName: string,
	task: string,
	now = new Date(),
): Promise<string> {
	if (configDirectoryName.replaceAll("\\", "/") !== PLAN_CONFIG_DIRECTORY) {
		throw unsafePlanPath("Plan publication paths must use the project-relative .pi directory");
	}
	const readableName = slugifyTask(task) || "plan";
	let candidateTime = now;

	while (true) {
		const filename = `${formatTimestamp(candidateTime)}-${readableName}.md`;
		const relativePath = join(PLAN_CONFIG_DIRECTORY, PLANS_DIRECTORY, filename);
		const location = await canonicalPlanLocation(cwd, relativePath, false);
		try {
			if (!(await pathEntryExists(location.absolutePath))) return relativePath;
		} catch (error) {
			throw unsafePlanPath("The plan destination could not be inspected safely", error);
		}
		candidateTime = new Date(candidateTime.getTime() + 1_000);
	}
}

function advanceGeneratedPlanPath(planPath: string): string {
	const match = /^(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})-(.+)\.md$/.exec(basename(planPath));
	if (!match) throw new Error(`Cannot advance non-generated plan path: ${planPath}`);

	const [, date, hours, minutes, seconds, readableName] = match;
	const timestamp = new Date(`${date}T${hours}:${minutes}:${seconds}Z`);
	if (Number.isNaN(timestamp.getTime())) throw new Error(`Cannot advance invalid plan timestamp: ${planPath}`);
	timestamp.setUTCSeconds(timestamp.getUTCSeconds() + 1);
	return join(dirname(planPath), `${formatTimestamp(timestamp)}-${readableName}.md`);
}

export async function resolveAvailablePlanPath(cwd: string, generatedPlanPath: string): Promise<string> {
	let candidatePath = generatedPlanPath;
	while (true) {
		const location = await canonicalPlanLocation(cwd, candidatePath, false);
		try {
			if (!(await pathEntryExists(location.absolutePath))) return candidatePath;
		} catch (error) {
			throw unsafePlanPath("The plan destination could not be inspected safely", error);
		}
		candidatePath = advanceGeneratedPlanPath(candidatePath);
	}
}

export async function createPlanFileAtPath(
	cwd: string,
	planPath: string,
	content: string,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted();
	const queuedLocation = await canonicalPlanLocation(cwd, planPath, false);
	signal?.throwIfAborted();
	return withFileMutationQueue(queuedLocation.absolutePath, async () => {
		signal?.throwIfAborted();
		const location = await canonicalPlanLocation(cwd, planPath, false);
		if (location.absolutePath !== queuedLocation.absolutePath) {
			throw unsafePlanPath("The canonical plan destination changed before publication");
		}
		signal?.throwIfAborted();
		await ensureDirectory(location.configDirectory, ".pi");
		await ensureDirectory(location.plansDirectory, ".pi/plans");
		await validateExistingPlanParents(location, true);
		signal?.throwIfAborted();
		const temporaryPath = join(location.plansDirectory, `.${planFilename(planPath)}.${randomUUID()}.tmp`);

		try {
			await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
			signal?.throwIfAborted();
			await link(temporaryPath, location.absolutePath);
			return planPath;
		} finally {
			await rm(temporaryPath, { force: true }).catch(() => undefined);
		}
	});
}

function publicationConflict(planPath: string, reason: string, cause?: unknown): PlanPublicationConflictError {
	return new PlanPublicationConflictError(
		`Published plan conflict at ${planPath}: ${reason}. The file was not overwritten.`,
		cause === undefined ? undefined : { cause },
	);
}

const PUBLISHED_PLAN_OPEN_FLAGS =
	constants.O_RDONLY |
	(constants.O_NONBLOCK ?? 0) |
	(constants.O_NOFOLLOW ?? 0);
const MAX_PUBLISHED_PLAN_READ_BYTES = MAX_PLAN_CHECKPOINT_BYTES + 1;

function assertPublishedPlanSize(planPath: string, size: number): void {
	if (size > MAX_PLAN_CHECKPOINT_BYTES) {
		throw publicationConflict(
			planPath,
			`the content exceeds the ${MAX_PLAN_CHECKPOINT_BYTES}-byte checkpoint limit`,
		);
	}
}

async function readPublishedPlanBounded(handle: FileHandle, planPath: string): Promise<Buffer> {
	const buffer = Buffer.alloc(MAX_PUBLISHED_PLAN_READ_BYTES);
	let offset = 0;
	while (offset < buffer.length) {
		const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	assertPublishedPlanSize(planPath, offset);
	return buffer.subarray(0, offset);
}

function readPublishedPlanBoundedSync(descriptor: number, planPath: string): Buffer {
	const buffer = Buffer.alloc(MAX_PUBLISHED_PLAN_READ_BYTES);
	let offset = 0;
	while (offset < buffer.length) {
		const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, null);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	assertPublishedPlanSize(planPath, offset);
	return buffer.subarray(0, offset);
}

async function canonicalPublishedPlanLocation(
	cwd: string,
	planPath: string,
): Promise<CanonicalPlanLocation> {
	try {
		return await canonicalPlanLocation(cwd, planPath, true);
	} catch (error) {
		throw publicationConflict(planPath, "the parent directories are unsafe or unavailable", error);
	}
}

function verifyAndReplacePlanFileSync(
	location: CanonicalPlanLocation,
	planPath: string,
	temporaryPath: string,
	expectedDigest: string,
	signal?: AbortSignal,
): void {
	let descriptor: number | undefined;
	try {
		validateExistingPlanParentsSync(location);
		descriptor = openSync(location.absolutePath, PUBLISHED_PLAN_OPEN_FLAGS);
		const openedStat = fstatSync(descriptor);
		if (!openedStat.isFile()) {
			throw publicationConflict(planPath, "the destination is not a regular file");
		}
		assertPublishedPlanSize(planPath, openedStat.size);
		const bytes = readPublishedPlanBoundedSync(descriptor, planPath);
		const pathStat = lstatSync(location.absolutePath);
		if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
			throw publicationConflict(planPath, "the destination became a symlink or non-file entry");
		}
		if (pathStat.dev !== openedStat.dev || pathStat.ino !== openedStat.ino) {
			throw publicationConflict(planPath, "the destination changed while it was being verified");
		}
		if (contentDigest(bytes) !== expectedDigest) {
			throw publicationConflict(planPath, "the on-disk bytes changed after the last publication");
		}
		closeSync(descriptor);
		descriptor = undefined;
		validateExistingPlanParentsSync(location);

		// Keep the final open/fstat/read/lstat/digest check and replacement in one
		// synchronous, non-yielding JavaScript section. External OS writers are not
		// locked by this section and can still race these portable filesystem calls.
		signal?.throwIfAborted();
		renameSync(temporaryPath, location.absolutePath);
	} catch (error) {
		if (signal?.aborted && error === signal.reason) throw error;
		if (error instanceof PlanPublicationConflictError) throw error;
		const reason = error instanceof PlanPathSafetyError
			? "the parent directories became unsafe"
			: "the destination changed or could not be replaced safely";
		throw publicationConflict(planPath, reason, error);
	} finally {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				// Preserve the publication conflict that caused cleanup.
			}
		}
	}
}

export async function verifyPlanFileDigest(
	cwd: string,
	planPath: string,
	expectedDigest: string,
): Promise<void> {
	let handle;
	try {
		const location = await canonicalPublishedPlanLocation(cwd, planPath);
		handle = await open(location.absolutePath, PUBLISHED_PLAN_OPEN_FLAGS);
		const openedStat = await handle.stat();
		if (!openedStat.isFile()) throw publicationConflict(planPath, "the destination is not a regular file");
		assertPublishedPlanSize(planPath, openedStat.size);
		const bytes = await readPublishedPlanBounded(handle, planPath);
		if (contentDigest(bytes) !== expectedDigest) {
			throw publicationConflict(planPath, "the on-disk bytes changed after the last publication");
		}
		const pathStat = await lstat(location.absolutePath);
		if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
			throw publicationConflict(planPath, "the destination became a symlink or non-file entry");
		}
		if (pathStat.dev !== openedStat.dev || pathStat.ino !== openedStat.ino) {
			throw publicationConflict(planPath, "the destination changed while it was being verified");
		}
		await validateExistingPlanParents(location, true);
	} catch (error) {
		if (error instanceof PlanPublicationConflictError) throw error;
		throw publicationConflict(planPath, "the destination was deleted, replaced, or could not be verified", error);
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

export type PlanFileUpdateResult = {
	path: string;
	unchanged: boolean;
};

export async function updatePlanFileAtPath(
	cwd: string,
	planPath: string,
	content: string,
	expectedDigest: string,
	signal?: AbortSignal,
): Promise<PlanFileUpdateResult> {
	signal?.throwIfAborted();
	const queuedLocation = await canonicalPublishedPlanLocation(cwd, planPath);
	signal?.throwIfAborted();
	return withFileMutationQueue(queuedLocation.absolutePath, async () => {
		signal?.throwIfAborted();
		const location = await canonicalPublishedPlanLocation(cwd, planPath);
		if (location.absolutePath !== queuedLocation.absolutePath) {
			throw publicationConflict(planPath, "the canonical destination changed before update");
		}
		signal?.throwIfAborted();
		const nextDigest = contentDigest(content);
		if (nextDigest === expectedDigest) {
			await verifyPlanFileDigest(cwd, planPath, expectedDigest);
			signal?.throwIfAborted();
			return { path: planPath, unchanged: true };
		}

		const temporaryPath = join(location.plansDirectory, `.${planFilename(planPath)}.${randomUUID()}.tmp`);
		let temporaryHandle;
		try {
			temporaryHandle = await open(temporaryPath, "wx");
			await temporaryHandle.writeFile(content, { encoding: "utf8" });
			await temporaryHandle.sync();
			await temporaryHandle.close();
			temporaryHandle = undefined;
			signal?.throwIfAborted();

			verifyAndReplacePlanFileSync(location, planPath, temporaryPath, expectedDigest, signal);
			return { path: planPath, unchanged: false };
		} finally {
			await temporaryHandle?.close().catch(() => undefined);
			await rm(temporaryPath, { force: true }).catch(() => undefined);
		}
	});
}
