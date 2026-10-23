import {
  registerSlices,
  type TaskLifecycle,
} from "../../plugins/environment-slices/projected-lifecycle.ts";
import {
  SlicesProvider,
  providerId,
  type Publication,
} from "../../plugins/environment-slices/provider.ts";

export const slicesEnvironment = {
  name: "environment-slices",
  pluginId: providerId,
  autoInstall: true,
  defaultEnabled: true,
  register: registerSlices,
};

/** Repository settings retain the worktree default until explicitly changed. */
export function selectRepositoryEnvironment(
  repository: { environmentProviderId?: string | null },
  worktreeProviderId: string,
) {
  return repository.environmentProviderId ?? worktreeProviderId;
}
export function installSlicesEnvironment(
  lifecycle: TaskLifecycle,
  options: { binary: string; dataDir: string; publication: Publication },
) {
  slicesEnvironment.register(
    lifecycle,
    new SlicesProvider(options.binary, options.dataDir),
    options.publication,
  );
}
