import { expect, it } from "vitest";
import { listBundledPluginRegistrations } from "../../../apps/server/src/services/plugins/builtin-registry.js";

it("installs and enables the asks plugin by default", () => {
  const registrations = listBundledPluginRegistrations().filter(
    (plugin) => plugin.pluginId === "hyperfide-asks",
  );
  expect(registrations).toHaveLength(1);
  expect(registrations[0]).toMatchObject({
    name: "hyperfide-asks",
    autoInstall: true,
    defaultEnabled: true,
  });
});
