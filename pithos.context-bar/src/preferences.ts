import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export class ContextBarPreferences {
  private readonly path: string;

  constructor(agentDir = getAgentDir()) {
    this.path = join(agentDir, "context-bar.json");
  }

  loadCodexMeter(): boolean | undefined {
    try {
      const data: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!data || typeof data !== "object" || !("openAICodexMeter" in data)
        || typeof data.openAICodexMeter !== "boolean") {
        throw new Error("Invalid Codex meter preference");
      }
      return data.openAICodexMeter;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  saveCodexMeter(enabled: boolean): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify({ openAICodexMeter: enabled }, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporaryPath, this.path);
    } catch (error) {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // Keep the original write or rename error.
      }
      throw error;
    }
  }
}
