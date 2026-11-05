/** Probe-only collection tool. No production Guild routes or child execution. */
import assert from "node:assert/strict";
import { SessionManager, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { BackgroundLedger } from "../../src/background-ledger.ts";
import { createBackgroundJournal } from "../../src/background-journal.ts";

export default function(pi: ExtensionAPI) {
 let epoch = {};
 let ledger: BackgroundLedger;
 let journal: ReturnType<typeof createBackgroundJournal>;
 let sessionId: string;
 const usage = {input: 11, output: 17, cacheRead: 23, cacheWrite: 29, cacheWrite1h: 7, reasoning: 5,
  totalTokens: 80, cost: {input: .11, output: .17, cacheRead: .23, cacheWrite: .29, total: .8}};
 const control = {
  SessionManager, VERSION, createAssistantMessageEventStream, Text, usage,
  hooks: [] as {hook: string; runId: string; reconciliation: string}[],
  afterClaim: undefined as ((receipt: unknown) => Promise<never>) | undefined,
  mutation: "", journal: undefined as typeof journal | undefined,
  reserve(runId: string) {
   const token = ledger.reserve({sessionId, runId, taskId: `t-${runId}`, role: "coder", profile: "typescript"});
   ledger.observeTerminal(token, {runId, taskId: `t-${runId}`, role: "coder", profile: "typescript", status: "failed", exitCode: 1,
    usage: {input: 11, output: 17, cacheRead: 23, cacheWrite: 29, cost: .8, contextTokens: 80, turns: 1}, providerUsage: usage});
  },
  inspect(runId: string) { return ledger.inspect(runId); },
  reconcile(runId: string) { return ledger.reconcile(runId); },
  transition() { epoch = {}; },
  reload() { ledger = new BackgroundLedger(journal); ledger.restore(); },
 };
 pi.events.on("accounting-probe:control", receive => {
  assert.equal(typeof receive, "function");
  (receive as (value: typeof control) => void)(control);
 });
 pi.on("session_start", (_event, ctx) => {
  journal = createBackgroundJournal(pi, ctx, {getEpoch: () => epoch});
  control.journal = journal;
  ledger = new BackgroundLedger(journal);
  sessionId = ctx.sessionManager.getSessionId();
 });
 const observe = (hook: string, runId: string) => {
  const reconciliation = control.mutation === "early-ack" ? "persisted-matching" : ledger.reconcile(runId);
  control.hooks.push({hook, runId, reconciliation});
 };
 pi.on("tool_result", event => {
  if (event.toolName === "guild_wait" && event.toolCallId === "call-first") observe("tool_result", "first");
 });
 pi.on("message_end", event => {
  if (event.message.role === "toolResult" && event.message.toolCallId === "call-first") observe("message_end", "first");
 });
 pi.registerTool({name: "guild_wait", label: "Probe collection", description: "Collect a synthetic completed observation", parameters: Type.Object({runId: Type.String(), lost: Type.Optional(Type.Boolean())}),
  async execute(toolCallId, input) {
   const result = ledger.collect({sessionId, runId: input.runId, taskId: `t-${input.runId}`, collectionId: `collection-${toolCallId}`, toolCallId, epoch});
   if (result.kind === "first" && control.afterClaim) {
    assert.equal(ledger.reconcile(input.runId), "claimed-ambiguous");
    await control.afterClaim(result.receipt);
   }
   if (input.lost) {
    assert.equal(result.kind, "first");
    assert.equal(ledger.reconcile(input.runId), "claimed-ambiguous", "Claim exists before the lost return");
    throw new Error("scripted lost return after claim");
   }
   const details = result.kind === "first" ? {guildBackground: {version: 1, sessionId, runId: input.runId,
    taskId: `t-${input.runId}`, collectionId: result.receipt.collectionId}} : undefined;
   return {content: [{type: "text" as const, text: result.kind}], details,
    ...(result.kind === "first" ? {usage: result.nativeUsage} : control.mutation === "repeat-usage" ? {usage} : {})};
  },
 });
}
