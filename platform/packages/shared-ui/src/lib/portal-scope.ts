declare const __HYPERFIDE_PLUGIN_ID__: string | undefined;

export function usePortalScopeProps(): {
  "data-hyperfide-portaled-overlay": "";
  "data-hyperfide-plugin-root"?: "";
  "data-hyperfide-plugin"?: string;
} {
  const pluginId =
    typeof __HYPERFIDE_PLUGIN_ID__ === "string" ? __HYPERFIDE_PLUGIN_ID__ : undefined;
  return {
    "data-hyperfide-portaled-overlay": "",
    "data-hyperfide-plugin-root": "",
    ...(pluginId !== undefined ? { "data-hyperfide-plugin": pluginId } : {}),
  };
}
