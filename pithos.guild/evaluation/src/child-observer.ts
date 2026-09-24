// Evaluation-only Node preload. FD 3 is a private, exclusively created regular
// file owned by the supervisor, never model stdout. Guild children do not inherit
// this preload or descriptor. Do not import production prompts/runtime here.
import { channel } from "node:diagnostics_channel";
import { writeSync } from "node:fs";
import { MAX_CHILD_TRACE_BYTES } from "./limits.ts";

const limitMarker = Buffer.from(JSON.stringify({ version: 1, type: "observer_output_limit" }) + "\n");
let failed = false, capturedBytes = 0;
function emit(value: unknown): void {
  if (failed) return;
  try {
    let bytes = Buffer.from(JSON.stringify(value) + "\n");
    if (capturedBytes + bytes.length > MAX_CHILD_TRACE_BYTES - limitMarker.length) {
      bytes = limitMarker; failed = true;
    }
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(3, bytes, offset, bytes.length - offset);
      if (written === 0) throw new Error("No recording progress");
      offset += written;
    }
    capturedBytes += bytes.length;
  } catch {
    failed = true; // Missing observer_end makes the evidence incomplete.
    process.stderr.write("[guild-evaluation-observer] recording failed\n");
  }
}

emit({ version: 1, type: "observer_ready" });
channel("pithos.guild.child").subscribe(emit);
process.once("exit", () => emit({ version: 1, type: "observer_end" }));
