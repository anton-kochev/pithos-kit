/** Exploratory Pi 1.4 fixture: only a scripted provider, never an extra tool or live service. */
import assert from "node:assert/strict";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadChildTask } from "../../src/child-protocol.ts";
import { ASK_TOOL, SUBMIT_TOOL, BACKGROUND_CAPABILITY, childTools, validateResult } from "../../src/protocol.ts";

export default function (pi: ExtensionAPI) {
  const task = loadChildTask();
  const key = process.env.BACKGROUND_PROBE_TASK;
  assert.match(key ?? "", /^task-[012]$/);
  assert.equal(process.env.PI_OFFLINE, "1");
  const pid = process.pid;
  const callId = "original-question";
  const question = JSON.stringify({ key, pid, runId: task.runId, taskId: task.taskId });
  let requests = 0;
  pi.registerProvider("background-runtime-probe", {
    api: "background-runtime-probe", baseUrl: "https://background-runtime-probe.invalid",
    apiKey: "not-a-credential",
    models: [{ id: "scripted", name: "Scripted offline probe", reasoning: false, input: ["text"],
      contextWindow: 32000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider,
        model: model.id, timestamp: Date.now(), content: [], stopReason: "toolUse",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      try {
        assert.equal(model.provider, "background-runtime-probe");
        assert.equal(model.id, "scripted");
        assert.equal(process.pid, pid);
        assert.ok(!options?.signal?.aborted);
        assert.ok(++requests <= 2, "Third provider turn forbidden; no fallback");
        assert.deepEqual(pi.getActiveTools().sort(), childTools(task.role, BACKGROUND_CAPABILITY).sort());
        const results = context.messages.filter(m => m.role === "toolResult");
        let args: ToolCall["arguments"];
        if (requests === 1) {
          assert.equal(results.length, 0);
          args = { question };
        } else {
          assert.equal(results.length, 1);
          assert.equal(results[0].toolCallId, callId);
          assert.equal(results[0].toolName, ASK_TOOL);
          assert.equal(results[0].isError, false);
          assert.deepEqual(results[0].content, [{ type: "text", text: JSON.stringify({ outcome: "answered", answer: `answer-for-${key}` }) }]);
          const { protocol, version, runId, taskId, role, profile } = task;
          args = { protocol, version, runId, taskId, role, profile, taskOutcome: "succeeded", compliance: [],
            summary: JSON.stringify({ key, pid, runId, taskId, requests, answer: `answer-for-${key}` }),
            blockers: [], limitations: ["Exploratory Pi 1.4 only; no live inference or Plan integration."],
            payload: role === "coder" ? { changes: [], verification: [] } : { scope: ["Runtime probe only"], findings: [], verdict: "Approve" } };
          validateResult(args, task);
        }
        const toolCall = { type: "toolCall" as const, id: requests === 1 ? callId : "original-submit",
          name: requests === 1 ? ASK_TOOL : SUBMIT_TOOL, arguments: args };
        stream.push({ type: "start", partial: message });
        message.content.push(toolCall);
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
        stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args), partial: message });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
        stream.push({ type: "done", reason: "toolUse", message });
      } catch (error) {
        message.stopReason = options?.signal?.aborted ? "aborted" : "error";
        message.errorMessage = String(error).slice(0, 2048);
        stream.push({ type: "error", reason: message.stopReason, error: message });
      }
      stream.end();
      return stream;
    },
  });
}
