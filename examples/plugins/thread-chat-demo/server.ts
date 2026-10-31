import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";

export default function plugin(hyperfide: HyperfidePluginApi) {
  hyperfide.log.info("thread-chat-demo loaded (frontend-only demo)");
}
