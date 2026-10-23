import type { BbPluginApi } from "@hyperfide/plugin-sdk";

export default function plugin(bb: BbPluginApi) {
  bb.log.info("thread-chat-demo loaded (frontend-only demo)");
}
