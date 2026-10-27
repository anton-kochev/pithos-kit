import assert from "node:assert/strict";
import { it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { renderGuildResult, renderGuildLifecycleMessage } from "../src/ui.ts";

initTheme();
const theme = {fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text} as any;

it("shows writer permissions and only the content-craft receipt ID in tool and direct results", () => {
 for (const taskOutcome of ["succeeded", "blocked"]) for (const expanded of [false, true]) {
  const details = {status: "completed", taskOutcome, role: "writer", profile: "general", source: "package", task: "Write stories/music.md", output: "Writer report", selectedSkills: [
   {id: "content-craft", source: "package", path: "private/craft", bytes: 12, sha256: "privatehash"},
   {id: "unrecognized", source: "package"},
  ]};
  for (const text of [
   renderGuildResult({details}, {expanded}, theme).render(120).join("\n"),
   renderGuildLifecycleMessage({details}, {expanded}, theme).render(120).join("\n"),
  ]) {
   assert.match(text, /content-craft/);
   assert.doesNotMatch(text, /private\/|privatehash|unrecognized/);
   if (taskOutcome === "blocked") assert.match(text, /Blocked/);
  }
  const lifecycle = renderGuildLifecycleMessage({details}, {expanded}, theme).render(120).join("\n");
  assert.match(lifecycle, /writer\/general.*package.*write-enabled \(no shell\)/i);
 }
});
