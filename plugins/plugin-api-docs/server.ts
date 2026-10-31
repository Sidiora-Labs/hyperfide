import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import {
  PLUGIN_GUIDE_SURFACE_PROVIDER_ID,
  pluginSurfaceAgentContext,
} from "./src/agent-reference";

export default function plugin(hyperfide: HyperfidePluginApi) {
  hyperfide.ui.registerMentionProvider({
    id: PLUGIN_GUIDE_SURFACE_PROVIDER_ID,
    label: "Plugin Guide",
    search: () => [],
    resolve(surfaceId) {
      const context = pluginSurfaceAgentContext(surfaceId);
      if (context === null) {
        throw new Error(`Unknown Plugin Guide surface: ${surfaceId}`);
      }
      return { context };
    },
  });
  hyperfide.log.debug("plugin API docs loaded");
}
