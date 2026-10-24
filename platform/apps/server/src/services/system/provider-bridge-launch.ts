import { type HostDaemonBridgeLaunch } from "@hyperfide/host-daemon-contract";
import { ApiError } from "../../errors.js";
import type { ProviderRegistration } from "../providers/provider-registry.js";
import type { AppDeps } from "../../types.js";

export async function resolveBridgeLaunchForProviderId(
  deps: Pick<AppDeps, "providerRegistry" | "pluginHostArtifacts">,
  providerId: string,
): Promise<HostDaemonBridgeLaunch | null> {
  const registration = deps.providerRegistry.get(providerId);
  if (
    registration === null ||
    (await deps.providerRegistry.disabledProviderIds()).has(providerId)
  ) {
    return null;
  }
  const source = resolveBridgeSource(deps, registration);
  if (source === null) {
    return null;
  }
  const pluginId = registration.pluginId;
  const {
    supportsServiceTier,
    supportsThreadArchive,
    supportsThreadRename,
    permissionModes,
  } = registration.info.capabilities;
  const fork = registration.serverCapabilities.fork;
  return {
    pluginId,
    source,
    providerOptions: { ...registration.bridgeOptions },
    envPassthrough: [...registration.envPassthrough],
    capabilities: {
      providerInstallation: registration.info.maintenance.installation,
      supportsServiceTier,
      supportsThreadArchive,
      supportsThreadRename,
      permissionModes: [...permissionModes],
      fork,
    },
  };
}

export async function requireBridgeLaunchForProviderId(
  deps: Pick<AppDeps, "providerRegistry" | "pluginHostArtifacts">,
  providerId: string,
): Promise<HostDaemonBridgeLaunch> {
  if ((await deps.providerRegistry.disabledProviderIds()).has(providerId)) {
    throw new ApiError(
      409,
      "provider_disabled",
      `Provider "${providerId}" is disabled. Enable it in Settings → Providers to start a new turn.`,
    );
  }
  const bridgeLaunch = await resolveBridgeLaunchForProviderId(deps, providerId);
  if (bridgeLaunch === null) {
    throw new ApiError(
      409,
      "provider_bridge_unavailable",
      `Provider "${providerId}" has no bridge to run on. Its plugin may be disabled or still building.`,
    );
  }
  return bridgeLaunch;
}

function resolveBridgeSource(
  deps: Pick<AppDeps, "pluginHostArtifacts">,
  registration: ProviderRegistration,
): HostDaemonBridgeLaunch["source"] | null {
  const artifact = deps.pluginHostArtifacts.get(registration.pluginId);
  if (artifact === undefined) {
    return null;
  }
  return {
    kind: "artifact",
    digest: artifact.digest,
    byteLength: artifact.byteLength,
  };
}
