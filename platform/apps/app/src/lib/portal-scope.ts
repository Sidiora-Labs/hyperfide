import { useContext } from "react";
import { PluginContext } from "@/components/plugin/plugin-context";

export function usePortalScopeProps(): {
  "data-hyperfide-portaled-overlay": "";
  "data-hyperfide-plugin-root"?: "";
  "data-hyperfide-plugin"?: string;
} {
  const pluginId = useContext(PluginContext);
  return pluginId === null
    ? { "data-hyperfide-portaled-overlay": "" }
    : {
        "data-hyperfide-portaled-overlay": "",
        "data-hyperfide-plugin-root": "",
        "data-hyperfide-plugin": pluginId,
      };
}
