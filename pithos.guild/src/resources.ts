import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { GUILD_ROLES, type GuildRole } from "./agents.ts";
import type { GuildPractice } from "./protocol.ts";

const CORE_LIMIT = 32 * 1024;
const CORE_PATHS = {
 tdd: "skills/tdd/SKILL.md",
 "code-review-standards": "skills/code-review-standards/SKILL.md",
} as const;
export interface GuildSkillReceipt {
 id: keyof typeof CORE_PATHS;
 source: "package";
 path: string;
 bytes: number;
 sha256: string;
}
export interface GuildSkillCore {
 receipt: GuildSkillReceipt;
 sourcePath: string;
 content: string;
}

/** root is injected only for offline fixture tests; production always supplies this module's package root. */
export async function loadGuildSkillCores(root: string, role: GuildRole, practices: readonly GuildPractice[]): Promise<GuildSkillCore[]> {
 if (!GUILD_ROLES.includes(role)) throw new Error("Invalid Guild role for skill selection");
 const id = role === "reviewer" ? "code-review-standards" : role === "coder" && practices.some(p => p.id === "tdd" && p.policy === "required") ? "tdd" : undefined;
 if (!id) return [];
 const relative = CORE_PATHS[id], rootPath = path.resolve(root), sourcePath = path.join(rootPath, relative);
 if (await fs.promises.realpath(rootPath) !== rootPath) throw new Error("Guild skill package root is not canonical");
 // Reject path substitution at every path component, not just the final file.
 const components = relative.split("/");
 for (let index = 0; index < components.length; index++) {
  const stat = await fs.promises.lstat(path.join(rootPath, ...components.slice(0, index + 1)));
  if (stat.isSymbolicLink() || (index === components.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error("Guild skill core is not a regular canonical package file");
 }
 if (await fs.promises.realpath(sourcePath) !== sourcePath) throw new Error("Guild skill core is not package-contained");
 const file = await fs.promises.open(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
 try {
  const stat = await file.stat();
  const named = await fs.promises.lstat(sourcePath);
  if (!stat.isFile() || !named.isFile() || stat.dev !== named.dev || stat.ino !== named.ino) throw new Error("Guild skill core is not a regular canonical package file");
  if (stat.size > CORE_LIMIT) throw new Error("Guild skill core size limit exceeded");
  const bytes = Buffer.alloc(CORE_LIMIT + 1);
  let count = 0;
  while (count < bytes.length) {
   const {bytesRead} = await file.read(bytes, count, bytes.length - count, count);
   if (!bytesRead) break;
   count += bytesRead;
  }
  if (count > CORE_LIMIT) throw new Error("Guild skill core size limit exceeded");
  const raw = bytes.subarray(0, count);
  const content = new TextDecoder("utf-8", {fatal: true}).decode(raw);
  return [{sourcePath, content, receipt: {id, source: "package", path: relative, bytes: count, sha256: createHash("sha256").update(raw).digest("hex")}}];
 } finally { await file.close(); }
}
