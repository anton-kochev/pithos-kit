/** Repository-only exploratory fixture: no service, credentials, or model inference. */
import assert from "node:assert/strict";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  const task = process.env.RPC_PROBE_TASK;
  assert.ok(task);
  assert.match(task, /^task-[012]$/);
  assert.equal(process.env.PI_OFFLINE, "1");
  const answer = `answer-for-${task}`;
  const callId = "original-question"; // Intentionally identical across processes.
  let requests = 0;
  let executions = 0;
  let resumed = false;

  pi.registerTool({
    name: "probe_question",
    label: "Probe question",
    description: "Repository-only RPC compatibility question",
    parameters: Type.Object({ task: Type.String() }),
    async execute(id, args, _signal, _update, ctx) {
      assert.equal(++executions, 1);
      assert.equal(id, callId);
      assert.equal(args.task, task);
      assert.equal(ctx.hasUI, true);
      const pid = process.pid;
      const value = await ctx.ui.input(JSON.stringify({ task, pid, callId }));
      assert.equal(value, answer);
      assert.equal(process.pid, pid);
      resumed = true;
      return {
        content: [{ type: "text", text: JSON.stringify({ task, pid, callId, answer: value }) }],
        details: { task, pid, callId, answer: value },
      };
    },
  });

  pi.registerProvider("rpc-compat-probe", {
    api: "rpc-compat-probe",
    baseUrl: "https://rpc-compat-probe.invalid",
    apiKey: "not-a-credential",
    models: [{
      id: "scripted", name: "Scripted (no inference)", reasoning: false,
      input: ["text"], contextWindow: 32000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model, context, options) {
      // No fallback to a built-in API, even on unexpected requests or cancellation.
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), content: [], stopReason: "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      try {
        assert.equal(model.provider, "rpc-compat-probe");
        assert.equal(model.id, "scripted");
        assert.ok(!options?.signal?.aborted);
        assert.ok(++requests <= 2, "Unexpected additional provider request");
        const users = context.messages.filter(m => m.role === "user");
        assert.equal(users.length, 1);
        const user = users[0];
        assert.equal(typeof user.content === "string" ? user.content :
          user.content.map(c => c.type === "text" ? c.text : "").join(""), task);
        stream.push({ type: "start", partial: message });
        if (requests === 1) {
          assert.equal(executions, 0);
          const toolCall = { type: "toolCall" as const, id: callId,
            name: "probe_question", arguments: { task } };
          message.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({ type: "toolcall_delta", contentIndex: 0,
            delta: JSON.stringify(toolCall.arguments), partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
          message.stopReason = "toolUse";
          stream.push({ type: "done", reason: "toolUse", message });
        } else {
          assert.equal(resumed, true);
          const results = context.messages.filter(m => m.role === "toolResult");
          assert.equal(results.length, 1);
          const result = results[0];
          assert.equal(result.toolCallId, callId);
          assert.equal(result.isError, false);
          assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify({
            task, pid: process.pid, callId, answer,
          }) }]);
          const text = JSON.stringify({ observed: answer, task, pid: process.pid, requests });
          message.content.push({ type: "text", text });
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
          stream.push({ type: "done", reason: "stop", message });
        }
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
