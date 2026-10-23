import type { BbPluginApi } from "@hyperfide/plugin-sdk";

export default function contentScriptExample(bb: BbPluginApi) {
  bb.log.info("Content script example loaded");
}
