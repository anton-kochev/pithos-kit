// Finite synthetic transport, not a provider or general networking replacement.
export function syntheticTransport(options?: { actor: "guild-parent" | "guild-child"; identity: string }) {
  const counts = { version: 1, sockets: 0, sends: 0, fetches: 0, rejected: 0 };
  let handoffs = 0;
  class SyntheticSocket extends EventTarget {
    static OPEN = 1; static CLOSED = 3;
    readyState = 0;
    constructor(..._args: any[]) {
      super(); counts.sockets++;
      queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.dispatchEvent(new Event("open")); } });
    }
    send(data: unknown) {
      if (counts.sends >= (options?.actor === "guild-parent" ? 2 : 1)) { counts.rejected++; throw new Error("Synthetic request limit"); }
      try {
        if (this.readyState !== 1 || typeof data !== "string" || Buffer.byteLength(data) > 1024 * 1024) throw Error();
        const payload = JSON.parse(data);
        if (payload.type !== "response.create" || payload.model !== "gpt-6-astra" || payload.reasoning?.effort !== "high"
          || (payload.service_tier !== undefined && payload.service_tier !== "default")) throw Error();
        if (options?.actor === "guild-parent" && counts.sends === 1) {
          const results = payload.input?.filter((item: any) => item.type === "function_call_output");
          if (results?.length !== 2 || ["explorer", "coder"].some(role => results.filter((r: any) => r.call_id === `call-synthetic-${role}` && r.output === "Synthetic offline result").length !== 1)) throw Error();
          handoffs = 2;
        }
      } catch { counts.rejected++; throw new Error("Synthetic payload mismatch"); }
      counts.sends++;
      const item = { type: "message", id: "msg-synthetic-main", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Synthetic offline result", annotations: [] }] };
      const output = options?.actor === "guild-parent" && counts.sends === 1
        ? ["explorer", "coder"].map(role => ({ type: "function_call", id: `fc-synthetic-${role}`, call_id: `call-synthetic-${role}`, name: "guild_handover",
          arguments: JSON.stringify({ role, profile: "typescript", task: "Synthetic offline transport fixture. No repository mutation is requested." }), status: "completed" })) : [item];
      const events = [
        ...output.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
        { type: "response.completed", response: { id: options ? `resp-synthetic-${options.identity}-${counts.sends}` : "resp-synthetic-main", status: "completed", service_tier: "default", output,
          usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 } } } },
      ];
      // Let the SDK install its response iterator after send() returns.
      setTimeout(() => { if (this.readyState === 1) for (const event of events) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })); }, 0);
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(Object.assign(new Event("close"), { code: 1000, reason: "synthetic end", wasClean: true })); }
  }
  return {
    WebSocket: SyntheticSocket as unknown as typeof WebSocket,
    fetch: (async () => { counts.fetches++; throw new Error("Synthetic HTTP fallback forbidden"); }) as typeof fetch,
    snapshot: () => ({ ...counts, ...(options?.actor === "guild-parent" ? { handoffs } : {}) }),
  };
}
