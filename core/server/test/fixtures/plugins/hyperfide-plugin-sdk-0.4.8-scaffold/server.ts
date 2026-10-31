import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";

export default function plugin(hyperfide: HyperfidePluginApi) {
  hyperfide.log.info("0.4.8 scaffold upgrade fixture loaded");
}
