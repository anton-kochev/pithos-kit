// Explicit RPC child entry only; normal extension discovery must not load this file.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadChildTask, registerChildProtocol } from "./child-protocol.ts";
import { BACKGROUND_CAPABILITY } from "./protocol.ts";

export default function backgroundChildProtocol(pi: ExtensionAPI): void {
 registerChildProtocol(pi, loadChildTask(), {capability: BACKGROUND_CAPABILITY});
}
