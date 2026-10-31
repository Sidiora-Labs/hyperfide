import {
  type EnvironmentDisplayInfo,
  type EnvironmentDisplayProviderLookup,
  formatEnvironmentDisplay,
} from "@hyperfide/core-ui";
import type { HyperfideSdk } from "@hyperfide/sdk";

export interface ThreadEnvironmentInfo {
  display: EnvironmentDisplayInfo;
  hostId: string;
}

async function resolveEnvironmentProvider(args: {
  environmentProviderId: string | null;
  sdk: HyperfideSdk;
}): Promise<EnvironmentDisplayProviderLookup> {
  if (args.environmentProviderId === null) {
    return { status: "loaded", provider: null };
  }
  const providers = await args.sdk.environments.listProviders();
  const provider = providers.find(
    (candidate) => candidate.id === args.environmentProviderId,
  );
  return {
    status: "loaded",
    provider:
      provider === undefined
        ? null
        : {
            id: provider.id,
            displayName: provider.displayName,
            icon: provider.icon,
          },
  };
}

export async function fetchEnvironmentInfo(args: {
  environmentId: string;
  sdk: HyperfideSdk;
}): Promise<ThreadEnvironmentInfo | null> {
  try {
    const env = await args.sdk.environments.get({
      environmentId: args.environmentId,
    });
    return {
      display: formatEnvironmentDisplay({
        environment: env,
        host: {
          locality: "local",
          identity: null,
        },
        providerLookup: await resolveEnvironmentProvider({
          environmentProviderId: env.environmentProviderId,
          sdk: args.sdk,
        }),
      }),
      hostId: env.hostId,
    };
  } catch {
    return null;
  }
}

export function printEnvironmentInfo(env: ThreadEnvironmentInfo): void {
  console.log(`  Environment: ${env.display.modeLabel} (${env.display.id})`);
}
