export { default as installSlicesEnvironment } from "../../plugins/environment-slices/server.ts";
export { providerId } from "../../plugins/environment-slices/provider.ts";
/** Repository settings retain the worktree default until explicitly changed. */
export function selectRepositoryEnvironment(
  repository: { environmentProviderId?: string | null },
  worktreeProviderId: string,
) {
  return repository.environmentProviderId ?? worktreeProviderId;
}
