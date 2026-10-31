import {
  queryOptions,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { ThreadListResponse } from "@hyperfide/server-contract";
import { useThreadListRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { sdk } from "@/lib/sdk";
import { threadListQueryKey } from "./query-keys";
import {
  THREAD_LIST_STALE_TIME_MS,
  THREAD_SEARCH_LIMIT_PER_GROUP,
  threadListRead,
} from "./thread-queries";

export function paletteRecentArchivedThreadsQueryOptions({
  enabled,
  queryClient,
}: {
  enabled: boolean;
  queryClient: QueryClient;
}) {
  const filters = {
    archived: true,
    limit: THREAD_SEARCH_LIMIT_PER_GROUP,
  };
  const queryKey = threadListQueryKey(filters);
  return queryOptions<ThreadListResponse>({
    queryKey,
    ...threadListRead(queryClient, queryKey, (signal) =>
      sdk.threads.list({ ...filters, signal }),
    ),
    enabled,
    staleTime: THREAD_LIST_STALE_TIME_MS,
  });
}

export function usePaletteRecentArchivedThreads({
  enabled,
}: {
  enabled: boolean;
}) {
  const queryClient = useQueryClient();
  useThreadListRealtimeSubscription({ enabled });
  return useQuery(
    paletteRecentArchivedThreadsQueryOptions({ enabled, queryClient }),
  );
}
