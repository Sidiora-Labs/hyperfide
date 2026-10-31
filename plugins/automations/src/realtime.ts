import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";

type AutomationSignalKind = "automations-changed" | "automation-runs-changed";

export function publishAutomationChange(
  hyperfide: Pick<HyperfidePluginApi, "realtime">,
  projectId: string,
  kinds: AutomationSignalKind | AutomationSignalKind[],
): void {
  for (const kind of Array.isArray(kinds) ? kinds : [kinds]) {
    hyperfide.realtime.publish("automations", { projectId, kind });
  }
}
