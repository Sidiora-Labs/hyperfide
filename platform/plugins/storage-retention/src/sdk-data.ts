import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
export async function readThreads(hyperfide: HyperfidePluginApi, signal?: AbortSignal) {
  const rows: Awaited<ReturnType<typeof hyperfide.sdk.threads.list>> = [];
  for (let offset = 0; ; offset += 500) {
    signal?.throwIfAborted();
    const page = await hyperfide.sdk.threads.list({
      includeHidden: true,
      limit: 500,
      offset,
      signal,
    });
    rows.push(...page);
    if (page.length < 500) return rows;
  }
}
export async function readThreadsById(
  hyperfide: HyperfidePluginApi,
  threadIds: readonly string[],
  signal?: AbortSignal,
) {
  const rows: Awaited<ReturnType<typeof hyperfide.sdk.threads.list>> = [];
  for (let offset = 0; offset < threadIds.length; offset += 200) {
    signal?.throwIfAborted();
    rows.push(
      ...(await hyperfide.sdk.threads.list({
        includeHidden: true,
        threadIds: threadIds.slice(offset, offset + 200),
        signal,
      })),
    );
  }
  return new Map(rows.map((thread) => [thread.id, thread]));
}
