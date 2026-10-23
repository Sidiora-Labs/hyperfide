import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";

export default function contentScriptExample(hyperfide: HyperfidePluginApi) {
  hyperfide.log.info("Content script example loaded");
}
