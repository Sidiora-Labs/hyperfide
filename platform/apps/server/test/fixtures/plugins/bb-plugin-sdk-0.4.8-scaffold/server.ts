import type { BbPluginApi } from "@hyperfide/plugin-sdk";

export default function plugin(bb: BbPluginApi) {
  bb.log.info("0.4.8 scaffold upgrade fixture loaded");
}
