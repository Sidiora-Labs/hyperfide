import type { PluginAppDefinition, PluginAppSetup } from "@hyperfide/plugin-sdk";
import { collectPluginAppRegistrations } from "@hyperfide/plugin-sdk/internal/plugin-app-collector";

export { collectPluginAppRegistrations };

export function definePluginApp(setup: PluginAppSetup): PluginAppDefinition {
  if (typeof setup !== "function") {
    throw new Error("definePluginApp expects a setup function");
  }
  return Object.freeze({ __hyperfidePluginApp: true as const, setup });
}
export function isPluginAppDefinition(
  value: unknown,
): value is PluginAppDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __hyperfidePluginApp?: unknown }).__hyperfidePluginApp === true &&
    typeof (value as { setup?: unknown }).setup === "function"
  );
}
