import {
  environmentHasLiveThreads,
  environments,
  findEnvironmentPathClaim,
  getHost,
  getPreparingEnvironment,
  getThread,
  type EnvironmentRow,
} from "@hyperfide/db";
import { canonicalizeHostPath } from "@hyperfide/domain";
import { eq } from "drizzle-orm";
import type { WorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";

export const CHECKOUT_BUSY_MESSAGE =
  "Cannot checkout branch while another thread is using this workspace";

export async function findBlockingEnvironmentPathClaim(
  deps: Pick<WorkSessionDeps, "db" | "hub">,
  args: { hostId: string; path: string; owner: EnvironmentRow | null },
): Promise<EnvironmentRow | null> {
  if (
    (await findEnvironmentPathClaim(
      deps.db,
      args.hostId,
      args.path,
      args.owner,
    )) === null
  )
    return null;
  return await deps.db.transaction(
    async () => {
      let claim = await findEnvironmentPathClaim(
        deps.db,
        args.hostId,
        args.path,
        args.owner,
      );
      while (claim !== null) {
        if (claim.ownerThreadId === null || claim.teardownStatus !== null)
          return claim;
        const owner = await getThread(deps.db, claim.ownerThreadId);
        if (owner?.status === "starting" || owner?.status === "stopping")
          return claim;
        if ((await getHost(deps.db, claim.hostId))?.phase === "removing")
          return claim;
        const reusable =
          (claim.status === "ready" && claim.path !== null) ||
          (await environmentHasLiveThreads(deps.db, claim.id));
        const updated = await deps.db
          .update(environments)
          .set(
            reusable
              ? {
                  updatedAt: Date.now(),
                  ownerThreadId: null,
                  claimPath: null,
                  statusMessage: null,
                  retireAt: null,
                }
              : {
                  updatedAt: Date.now(),
                  teardownStatus: "running",
                  retireAt: Date.now(),
                },
          )
          .where(eq(environments.id, claim.id))
          .run();
        if (updated.changes === 0) return claim;
        await deps.hub.notifyEnvironment(claim.id, ["metadata-changed"]);
        if (!reusable) return { ...claim, teardownStatus: "running" };
        claim = await findEnvironmentPathClaim(
          deps.db,
          args.hostId,
          args.path,
          args.owner,
        );
      }
      return null;
    },
    { behavior: "immediate" },
  );
}

export async function assertEnvironmentPathAvailable(
  deps: Pick<WorkSessionDeps, "db" | "hub">,
  args: { hostId: string; path: string | null; threadId: string | null },
): Promise<void> {
  if (args.path === null) return;
  const path = canonicalizeHostPath(args.path);
  const owner =
    args.threadId === null
      ? null
      : await getPreparingEnvironment(deps.db, args.threadId);
  const claim = await findBlockingEnvironmentPathClaim(deps, {
    hostId: args.hostId,
    path,
    owner,
  });
  if (claim !== null) {
    throw new ApiError(
      409,
      "workspace_busy",
      claim.teardownStatus === null
        ? CHECKOUT_BUSY_MESSAGE
        : "Workspace cleanup is pending. Try again shortly.",
    );
  }
}
