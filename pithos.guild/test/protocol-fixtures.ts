import { buildTask as buildHostTask } from "../src/protocol.ts";
import { randomUUID } from "node:crypto";
export function buildTask(input: Omit<Parameters<typeof buildHostTask>[0], "runId" | "taskId">) {
 return buildHostTask({...input, runId: randomUUID(), taskId: randomUUID()});
}

export function report(task: ReturnType<typeof buildTask>) {
 const { task: _text, practices: _practices, ...header } = task;
 const payloads = {
  explorer: { observations: [], unknowns: [] },
  architect: { decisions: [], contracts: [], handoff: [] },
  coder: { changes: [], verification: [] },
  reviewer: { scope: [], findings: [], verdict: "Approve" },
 };
 return { ...header, taskOutcome: "succeeded", compliance: [], summary: "Honest report", blockers: [], limitations: [], payload: payloads[task.role] };
}
