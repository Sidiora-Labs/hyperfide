import {
  getAppSettings,
  getDisabledProviderIds,
  setAppSettings,
  setDisabledProviderIds,
} from "@hyperfide/db";
import type { SystemProviderCatalogEntry } from "@hyperfide/server-contract";
import type { ServerAppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import type { PluginService } from "../plugins/plugin-service.js";

export async function providerManagementCatalog(
  deps: Pick<ServerAppDeps, "providerRegistry">,
  plugins: Pick<PluginService, "list" | "providerCatalog">,
): Promise<SystemProviderCatalogEntry[]> {
  const installed = new Map(
    (await plugins.list()).map((plugin) => [plugin.id, plugin]),
  );
  const disabled = await deps.providerRegistry.disabledProviderIds();
  const declared = new Map(
    (await plugins.providerCatalog()).map((provider) => [
      provider.id,
      provider,
    ]),
  );
  for (const entry of await deps.providerRegistry.list()) {
    declared.set(entry.info.id, {
      id: entry.info.id,
      displayName: entry.info.displayName,
      pluginId: entry.pluginId,
    });
  }
  return [...declared.values()].flatMap((entry) => {
    const plugin = installed.get(entry.pluginId);
    if (plugin === undefined) return [];
    const registration = deps.providerRegistry.get(entry.id);
    return [
      {
        ...entry,
        pluginName: plugin.name ?? plugin.id,
        pluginEnabled: plugin.enabled,
        enabled: !disabled.has(entry.id),
        available: registration?.info.available ?? false,
        logoUrl: registration?.info.logoUrl ?? plugin.iconUrl,
        info: registration?.info ?? null,
      },
    ];
  });
}

export async function setProviderEnabled(
  deps: Pick<ServerAppDeps, "db" | "providerRegistry" | "hub">,
  plugins: Pick<PluginService, "list" | "providerCatalog" | "setEnabled">,
  id: string,
  enabled: boolean,
): Promise<SystemProviderCatalogEntry[]> {
  const provider = (await providerManagementCatalog(deps, plugins)).find(
    (entry) => entry.id === id,
  );
  if (provider === undefined)
    throw new ApiError(404, "provider_not_found", `Unknown provider "${id}".`);
  if (enabled && !provider.pluginEnabled) {
    await plugins.setEnabled(provider.pluginId, true);
  }
  if (enabled) {
    if (deps.providerRegistry.get(id)?.info.available !== true) {
      throw new ApiError(
        409,
        "provider_unavailable",
        `Could not enable ${provider.displayName}. Check ${provider.pluginName} in Settings → Plugins.`,
      );
    }
  }
  const disabledProviderIds = (await getDisabledProviderIds(deps.db)).filter(
    (providerId) => providerId !== id,
  );
  if (!enabled) disabledProviderIds.push(id);
  await setDisabledProviderIds(deps.db, disabledProviderIds);
  const current = await getAppSettings(deps.db);
  if (!enabled && current.defaultProviderId === id) {
    await setAppSettings(deps.db, { ...current, defaultProviderId: null });
  }
  await deps.hub.notifySystem(["config-changed"]);
  return await providerManagementCatalog(deps, plugins);
}
