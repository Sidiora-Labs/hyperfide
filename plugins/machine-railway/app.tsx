import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@hyperfide/plugin-sdk/app";
import { Button } from "@hyperfide/shared-ui/button";
import { SettingsWithControl } from "@/components/ui/settings-section";
import { railwayContract, type RailwayStatus } from "./src/status-contract.js";

export function RailwaySettings() {
  const rpc = useRpc<typeof railwayContract>();
  const [status, setStatus] = useState<RailwayStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const refresh = useCallback(
    async (verify = false) => {
      setBusy(true);
      try {
        setStatus(
          await rpc.call(verify ? "railwayVerify" : "railwayStatus", {}),
        );
        setError(false);
      } catch {
        setError(true);
      } finally {
        setBusy(false);
      }
    },
    [rpc],
  );
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  const rows = status
    ? [
        [
          "Configured",
          status.configured ? "Yes" : "No - save both credentials below",
        ],
        ["Verified at", status.verifiedAt ?? "Not verified"],
        ["Project", status.projectName ?? "Unknown"],
        ["Environment", status.environmentName ?? "Unknown"],
        ["Region", status.region ?? "No region reported"],
        ["Sandboxes", status.sandboxCount?.toString() ?? "Not verified"],
        ["Provider machines", String(status.machineCount)],
        [
          "Lifecycle",
          status.machines.map((m) => m.phase).join(", ") ||
            "No machines created",
        ],
        ["Fleet enrollment", status.bootstrap.phase],
        ["Enrollment updated", status.bootstrap.updatedAt ?? "Not started"],
        [
          "Last error",
          status.lastError ?? status.bootstrap.lastError ?? "None",
        ],
      ]
    : [];
  return (
    <div className="min-w-0 space-y-4">
      <SettingsWithControl
        label="Railway connection"
        description="Save credentials below, then verify the connection to Railway."
      >
        <Button disabled={busy} onClick={() => void refresh(true)}>
          {busy ? "Checking..." : "Verify connection"}
        </Button>
      </SettingsWithControl>
      {error && (
        <p role="alert">
          Unable to load Railway status.{" "}
          <Button onClick={() => void refresh()}>Retry</Button>
        </p>
      )}
      {!status && !error && <p role="status">Loading Railway status...</p>}
      <dl
        className="grid min-w-0 grid-cols-1 gap-2 text-sm sm:grid-cols-2"
        aria-live="polite"
      >
        {rows.map(([label, value]) => (
          <div key={label} className="min-w-0 rounded border border-border p-3">
            <dt className="text-subtle-foreground">{label}</dt>
            <dd className="break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "railway-status",
    title: "Railway connection and fleet",
    component: RailwaySettings,
  });
});
