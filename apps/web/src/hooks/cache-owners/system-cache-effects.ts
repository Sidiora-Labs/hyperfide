import type { QueryKey } from "@tanstack/react-query";
import type { Environment, Host } from "@hyperfide/domain";
import type { RealtimeSubscriptionTarget } from "@hyperfide/server-contract";
import type {
  SystemConfigResponse,
  SystemProviderCatalogEntry,
} from "@hyperfide/server-contract";
import {
  allEnvironmentDiffFilesQueryKeyPrefix,
  allEnvironmentDiffPatchQueryKeyPrefix,
  allEnvironmentFilePreviewQueryKeyPrefix,
  environmentMergeBaseBranchesQueryKeyPrefix,
  allEnvironmentMergeBaseBranchesQueryKeyPrefix,
  allEnvironmentQueryKeyPrefix,
  allEnvironmentWorkStatusQueryKeyPrefix,
  environmentDiffFilesQueryKeyPrefix,
  environmentDiffPatchQueryKeyPrefix,
  environmentDiffViewedQueryKeyPrefix,
  environmentFilePreviewQueryKeyPrefix,
  environmentPathsQueryKeyPrefix,
  environmentWorkStatusQueryKeyPrefix,
  allHostQueryKeyPrefix,
  allMachineEnvironmentQueryKeyPrefix,
  allProjectCommandsQueryKeyPrefix,
  allProjectPathsQueryKeyPrefix,
  allProjectSourceBranchesQueryKeyPrefix,
  projectPathsQueryKeyPrefix,
  projectPromptHistoryQueryKey,
  projectPromptHistoryQueryKeyPrefix,
  projectSourceBranchesQueryKeyPrefix,
  allSystemExecutionOptionsQueryKeyPrefix,
  allSystemMachineProvidersQueryKeyPrefix,
  allSystemProvidersQueryKeyPrefix,
  allSystemThemesQueryKeyPrefix,
  allTerminalsQueryKeyPrefix,
  allPluginCatalogSearchQueryKeyPrefix,
  allPluginContributionsQueryKeyPrefix,
  allPluginListQueryKeyPrefix,
  allPluginSettingsQueryKeyPrefix,
  allPluginSettingsViewQueryKeyPrefix,
  allPluginSourceQueryKeyPrefix,
  pluginSafeModeQueryKey,
  pluginInstallJobsQueryKey,
  pluginMarketplacesQueryKey,
  pluginUpdateJobsQueryKey,
  allThreadConversationOutlineQueryKeyPrefix,
  allThreadDetailBootstrapQueryKeyPrefix,
  allThreadHostFilePreviewQueryKeyPrefix,
  allThreadPendingInteractionsQueryKeyPrefix,
  allThreadQueuedMessagesQueryKeyPrefix,
  allThreadQueryKeyPrefix,
  allThreadStorageFilePreviewQueryKeyPrefix,
  allThreadStorageFilesQueryKeyPrefix,
  allThreadStorageLocationsQueryKeyPrefix,
  allThreadStoragePathsQueryKeyPrefix,
  allThreadTimelineQueryKeyPrefix,
  allThreadTimelineTurnSummaryDetailsQueryKeyPrefix,
  threadTimelineQueryKeyPrefix,
  environmentQueryKey,
  hostProviderCliStatusQueryKey,
  hostPathExistenceQueryKeyPrefix,
  hostsQueryKey,
  hostQueryKey,
  projectsQueryKey,
  serverMoveStatusQueryKey,
  sidebarNavigationQueryKey,
  systemAiServicesQueryKey,
  systemConfigQueryKey,
  systemCliSkillsQueryKey,
  systemCliCommandQueryKey,
  systemAppUpdateQueryKey,
  systemMachineProvidersQueryKey,
  systemProviderCatalogQueryKey,
  systemExecutionOptionsEnvironmentQueryKeyPrefix,
  terminalsQueryKey,
  uiPreferencesQueryKey,
  threadPromptHistoryQueryKeyPrefix,
  threadSearchQueryKeyPrefix,
  threadsQueryKey,
} from "../queries/query-keys";
import { allThreadDefaultExecutionOptionsQueryKeyPrefix } from "../queries/thread-default-execution-options-query";
import type { QueryClientArg } from "../cache-effect-types";
import { clearCachedModelCatalogs } from "@/lib/model-catalog-cache";
import { bumpAllDiffPatchEvictionGenerations } from "./environment-diff-patch-cache-owner";
import { invalidateAppUpdateStatus } from "./app-update-cache-owner";
import { invalidatePluginList } from "./plugin-cache-owner";
import { invalidateSystemVersion } from "./system-version-cache-owner";
import {
  invalidateQueryKeys,
  refetchFailedActiveQueryKeys,
} from "./cache-effect-utils";

interface SystemExecutionOptionsInvalidationArgs extends QueryClientArg {
  hostId: string;
}

interface ServerReconnectInvalidationArgs extends QueryClientArg {
  disconnectedAt: number;
}

export function invalidateRealtimeQueriesAfterServerReconnect({
  disconnectedAt,
  queryClient,
}: ServerReconnectInvalidationArgs): void {
  for (const queryKey of getServerReconnectInvalidationQueryKeys()) {
    void queryClient.invalidateQueries(
      {
        queryKey,
        predicate: (query) => query.state.dataUpdatedAt < disconnectedAt,
      },
      { cancelRefetch: false },
    );
  }
  invalidateSystemVersion({ queryClient });
  invalidateAppUpdateStatus({ queryClient });
  bumpAllDiffPatchEvictionGenerations();
  queryClient.removeQueries({
    queryKey: allEnvironmentDiffPatchQueryKeyPrefix(),
  });
}

export function refetchErroredRealtimeQueriesOnInitialConnect({
  queryClient,
}: QueryClientArg): void {
  refetchFailedActiveQueryKeys({
    queryClient,
    queryKeys: getServerReconnectInvalidationQueryKeys(),
  });
}

interface InitialConnectInvalidationArgs extends QueryClientArg {
  connectedAt: number;
}

function refetchActiveQueryKeys(
  queryClient: QueryClientArg["queryClient"],
  queryKeys: readonly QueryKey[],
): void {
  for (const queryKey of queryKeys) {
    void queryClient
      .refetchQueries({ queryKey, type: "active" }, { cancelRefetch: false })
      .catch(() => {});
  }
}

function pluginResumeQueryKeys(pluginId: string): QueryKey[] {
  return [
    ["plugin-rpc", pluginId],
    allPluginCatalogSearchQueryKeyPrefix(),
    allPluginContributionsQueryKeyPrefix(),
    allPluginListQueryKeyPrefix(),
    allPluginSettingsQueryKeyPrefix(),
    allPluginSettingsViewQueryKeyPrefix(),
    allPluginSourceQueryKeyPrefix(),
    pluginInstallJobsQueryKey(),
    pluginMarketplacesQueryKey(),
    pluginSafeModeQueryKey(),
    pluginUpdateJobsQueryKey(),
  ];
}

function projectResumeQueryKeys(projectId?: string): QueryKey[] {
  return [
    projectsQueryKey(),
    sidebarNavigationQueryKey(),
    threadSearchQueryKeyPrefix(),
    allProjectCommandsQueryKeyPrefix(),
    ...(projectId
      ? [
          projectPathsQueryKeyPrefix(projectId),
          projectPromptHistoryQueryKey(projectId),
          projectSourceBranchesQueryKeyPrefix(projectId),
        ]
      : [
          allProjectPathsQueryKeyPrefix(),
          allProjectSourceBranchesQueryKeyPrefix(),
          projectPromptHistoryQueryKeyPrefix(),
        ]),
  ];
}

function environmentResumeQueryKeys(environmentId?: string): QueryKey[] {
  return [
    ...(environmentId
      ? [
          environmentQueryKey(environmentId),
          environmentDiffFilesQueryKeyPrefix(environmentId),
          environmentDiffPatchQueryKeyPrefix(environmentId),
          environmentDiffViewedQueryKeyPrefix(environmentId),
          environmentFilePreviewQueryKeyPrefix(environmentId),
          environmentMergeBaseBranchesQueryKeyPrefix(environmentId),
          environmentPathsQueryKeyPrefix(environmentId),
          environmentWorkStatusQueryKeyPrefix(environmentId),
          systemExecutionOptionsEnvironmentQueryKeyPrefix(environmentId),
          terminalsQueryKey({ kind: "environment", environmentId }),
        ]
      : [
          allEnvironmentDiffFilesQueryKeyPrefix(),
          allEnvironmentDiffPatchQueryKeyPrefix(),
          allEnvironmentFilePreviewQueryKeyPrefix(),
          allEnvironmentMergeBaseBranchesQueryKeyPrefix(),
          allEnvironmentQueryKeyPrefix(),
          allEnvironmentWorkStatusQueryKeyPrefix(),
          ["environmentPaths"],
          allTerminalsQueryKeyPrefix(),
        ]),
    ...(environmentId ? [] : [sidebarNavigationQueryKey()]),
  ];
}

function hostResumeQueryKeys(hostId?: string): QueryKey[] {
  return [
    hostsQueryKey(),
    ...(hostId ? [hostQueryKey(hostId)] : []),
    allHostQueryKeyPrefix(),
    hostPathExistenceQueryKeyPrefix(),
    allSystemExecutionOptionsQueryKeyPrefix(),
    allSystemProvidersQueryKeyPrefix(),
    hostId === undefined
      ? allTerminalsQueryKeyPrefix()
      : terminalsQueryKey({ kind: "host_path", hostId }),
    ...(hostId ? [hostProviderCliStatusQueryKey(hostId)] : []),
  ];
}

function systemResumeQueryKeys(): QueryKey[] {
  return [
    allMachineEnvironmentQueryKeyPrefix(),
    allSystemExecutionOptionsQueryKeyPrefix(),
    allSystemMachineProvidersQueryKeyPrefix(),
    allSystemProvidersQueryKeyPrefix(),
    allSystemThemesQueryKeyPrefix(),
    hostPathExistenceQueryKeyPrefix(),
    pluginInstallJobsQueryKey(),
    pluginUpdateJobsQueryKey(),
    serverMoveStatusQueryKey(),
    systemAiServicesQueryKey(),
    systemAppUpdateQueryKey(),
    systemCliCommandQueryKey(),
    systemCliSkillsQueryKey(),
    systemConfigQueryKey(),
    systemMachineProvidersQueryKey(),
    systemProviderCatalogQueryKey(),
    ["systemProviderStates"],
    uiPreferencesQueryKey(),
  ];
}

function releasedTargetQueryKeys(
  target: RealtimeSubscriptionTarget,
): QueryKey[] {
  switch (target.kind) {
    case "plugin":
    case "plugin-read":
      return pluginResumeQueryKeys(target.pluginId);
    case "project-list":
      return projectResumeQueryKeys();
    case "project-detail":
      return projectResumeQueryKeys(target.projectId);
    case "environment-list":
      return environmentResumeQueryKeys();
    case "environment-detail":
      return environmentResumeQueryKeys(target.environmentId);
    case "host-list":
      return hostResumeQueryKeys();
    case "host-detail":
      return hostResumeQueryKeys(target.hostId);
    case "system":
      return systemResumeQueryKeys();
    case "thread-detail":
      return [
        allThreadConversationOutlineQueryKeyPrefix(),
        allThreadDefaultExecutionOptionsQueryKeyPrefix(),
        allThreadDetailBootstrapQueryKeyPrefix(),
        allThreadHostFilePreviewQueryKeyPrefix(),
        allThreadPendingInteractionsQueryKeyPrefix(),
        threadPromptHistoryQueryKeyPrefix(),
        allThreadQueuedMessagesQueryKeyPrefix(),
        allThreadQueryKeyPrefix(),
        allThreadStorageFilePreviewQueryKeyPrefix(),
        allThreadStorageFilesQueryKeyPrefix(),
        allThreadStorageLocationsQueryKeyPrefix(),
        allThreadStoragePathsQueryKeyPrefix(),
        allThreadTimelineQueryKeyPrefix(),
        allThreadTimelineTurnSummaryDetailsQueryKeyPrefix(),
        threadSearchQueryKeyPrefix(),
        terminalsQueryKey({ kind: "thread", threadId: target.threadId }),
      ];
    case "thread-timeline":
      return [
        allThreadTimelineQueryKeyPrefix(),
        threadTimelineQueryKeyPrefix(target.threadId),
      ];
    case "thread-list":
      return [
        sidebarNavigationQueryKey(),
        threadSearchQueryKeyPrefix(),
        threadsQueryKey(),
      ];
    default:
      return [];
  }
}

export function invalidateRealtimeQueriesFetchedBeforeInitialConnect({
  connectedAt,
  queryClient,
}: InitialConnectInvalidationArgs): void {
  for (const queryKey of getServerReconnectInvalidationQueryKeys()) {
    queryClient.invalidateQueries({
      queryKey,
      predicate: (query) =>
        query.state.dataUpdatedAt !== 0 &&
        query.state.dataUpdatedAt < connectedAt,
    });
  }
}

export function refetchActiveRealtimeQueriesOnResume({
  queryClient,
  releasedTargets = [],
}: QueryClientArg & {
  releasedTargets?: readonly RealtimeSubscriptionTarget[];
}): void {
  refetchActiveQueryKeys(queryClient, [
    allThreadTimelineQueryKeyPrefix(),
    allThreadQueryKeyPrefix(),
    sidebarNavigationQueryKey(),
  ]);
  for (const target of releasedTargets) {
    refetchActiveQueryKeys(queryClient, releasedTargetQueryKeys(target));
  }
}

export function invalidateSystemConfig({ queryClient }: QueryClientArg): void {
  invalidateQueryKeys({
    queryClient,
    queryKeys: [systemConfigQueryKey(), allSystemThemesQueryKeyPrefix()],
  });
}

export function invalidateMachineEnvironment({
  queryClient,
}: QueryClientArg): void {
  invalidateQueryKeys({
    queryClient,
    queryKeys: [allMachineEnvironmentQueryKeyPrefix()],
  });
}

export async function applyProviderAvailabilityChange({
  queryClient,
  catalog,
}: QueryClientArg & { catalog: SystemProviderCatalogEntry[] }): Promise<void> {
  queryClient.setQueryData(systemProviderCatalogQueryKey(), catalog);
  await Promise.all([
    invalidateSystemProviders({ queryClient }),
    queryClient.invalidateQueries({
      queryKey: allSystemExecutionOptionsQueryKeyPrefix(),
    }),
    queryClient.invalidateQueries({ queryKey: systemConfigQueryKey() }),
    invalidatePluginList({ queryClient }),
  ]);
}

export function invalidateSystemProviders({
  queryClient,
}: QueryClientArg): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: allSystemProvidersQueryKeyPrefix(),
  });
}

export function invalidateMachineProviders({
  queryClient,
}: QueryClientArg): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: allSystemMachineProvidersQueryKeyPrefix(),
  });
}

export function invalidateSystemExecutionOptions({
  hostId,
  queryClient,
}: SystemExecutionOptionsInvalidationArgs): Promise<void> {
  const primaryHostId =
    queryClient.getQueryData<SystemConfigResponse>(systemConfigQueryKey())
      ?.primaryHostId ?? null;
  return queryClient.invalidateQueries({
    queryKey: allSystemExecutionOptionsQueryKeyPrefix(),
    predicate: (query) => {
      const [, environmentId, routedHostId] = query.queryKey;
      if (typeof routedHostId === "string") return routedHostId === hostId;
      if (typeof environmentId === "string") {
        const environment = queryClient.getQueryData<Environment>(
          environmentQueryKey(environmentId),
        );
        return environment === undefined || environment.hostId === hostId;
      }
      return primaryHostId === null || primaryHostId === hostId;
    },
  });
}

export function invalidateGeneralSettingsDependencies({
  includeSystemConfig,
  queryClient,
}: QueryClientArg & { includeSystemConfig: boolean }): void {
  invalidateQueryKeys({
    queryClient,
    queryKeys: [
      ...(includeSystemConfig ? [systemConfigQueryKey()] : []),
      allThreadTimelineQueryKeyPrefix(),
      allThreadTimelineTurnSummaryDetailsQueryKeyPrefix(),
    ],
  });
}

export function resetModelCatalogsAfterStreamerModeChange({
  queryClient,
}: QueryClientArg): Promise<void> {
  clearCachedModelCatalogs();
  return queryClient.resetQueries({
    queryKey: allSystemExecutionOptionsQueryKeyPrefix(),
  });
}

function getServerReconnectInvalidationQueryKeys(): QueryKey[] {
  return [
    hostsQueryKey(),
    allHostQueryKeyPrefix(),
    projectsQueryKey(),
    sidebarNavigationQueryKey(),
    allProjectPathsQueryKeyPrefix(),
    allProjectSourceBranchesQueryKeyPrefix(),
    allProjectCommandsQueryKeyPrefix(),
    projectPromptHistoryQueryKeyPrefix(),
    threadsQueryKey(),
    threadSearchQueryKeyPrefix(),
    allThreadQueryKeyPrefix(),
    allThreadDetailBootstrapQueryKeyPrefix(),
    allThreadTimelineQueryKeyPrefix(),
    allThreadConversationOutlineQueryKeyPrefix(),
    allThreadTimelineTurnSummaryDetailsQueryKeyPrefix(),
    allThreadQueuedMessagesQueryKeyPrefix(),
    threadPromptHistoryQueryKeyPrefix(),
    allThreadPendingInteractionsQueryKeyPrefix(),
    allThreadDefaultExecutionOptionsQueryKeyPrefix(),
    allThreadStorageFilesQueryKeyPrefix(),
    allThreadStorageLocationsQueryKeyPrefix(),
    allThreadStoragePathsQueryKeyPrefix(),
    allThreadStorageFilePreviewQueryKeyPrefix(),
    allThreadHostFilePreviewQueryKeyPrefix(),
    allTerminalsQueryKeyPrefix(),
    allEnvironmentQueryKeyPrefix(),
    allEnvironmentWorkStatusQueryKeyPrefix(),
    allEnvironmentMergeBaseBranchesQueryKeyPrefix(),
    allEnvironmentDiffFilesQueryKeyPrefix(),
    allEnvironmentFilePreviewQueryKeyPrefix(),
    hostPathExistenceQueryKeyPrefix(),
    allSystemProvidersQueryKeyPrefix(),
    allSystemExecutionOptionsQueryKeyPrefix(),
    serverMoveStatusQueryKey(),
  ];
}

export function applyHostRenameResult({
  host,
  queryClient,
}: QueryClientArg & { host: Host }): void {
  queryClient.setQueryData<Host[]>(hostsQueryKey(), (hosts) =>
    hosts?.map((current) => (current.id === host.id ? host : current)),
  );
}
