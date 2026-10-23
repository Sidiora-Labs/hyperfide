import type {
  DbConnection,
  DbNotifier,
  DbQueryConnection,
  DbTransaction,
} from "@hyperfide/db";
import {
  applyEnvironmentLifecycleEvent,
  applyEnvironmentLifecycleEventInTransaction,
  type ApplyEnvironmentLifecycleEventArgs,
  type ApplyEnvironmentLifecycleEventOutcome,
} from "@hyperfide/db/internal-environment-lifecycle";
import type { ServerLogger } from "../../types.js";

interface ApplyLoggedEnvironmentLifecycleEventDeps {
  db: DbQueryConnection;
  hub: DbNotifier;
  logger: ServerLogger;
}

interface ApplyLoggedEnvironmentLifecycleEventTransactionDeps {
  db: DbTransaction;
  logger: ServerLogger;
}

function logUnappliedEnvironmentLifecycleEvent(
  logger: ServerLogger,
  args: ApplyEnvironmentLifecycleEventArgs,
  outcome: ApplyEnvironmentLifecycleEventOutcome,
): void {
  if (outcome.applied) {
    return;
  }
  logger.info(
    {
      detail: outcome.detail,
      environmentId: args.environmentId,
      event: args.event.type,
      reason: outcome.reason,
    },
    "Environment lifecycle event not applied",
  );
}

function isDbConnection(db: DbQueryConnection): db is DbConnection {
  return "$client" in db;
}

export async function applyLoggedEnvironmentLifecycleEvent(
  deps: ApplyLoggedEnvironmentLifecycleEventDeps,
  args: ApplyEnvironmentLifecycleEventArgs,
): Promise<ApplyEnvironmentLifecycleEventOutcome> {
  const outcome = isDbConnection(deps.db)
    ? await applyEnvironmentLifecycleEvent(deps.db, deps.hub, args)
    : await applyEnvironmentLifecycleEventInTransaction(deps.db, args);
  if (!isDbConnection(deps.db) && outcome.applied) {
    deps.hub.notifyEnvironment(args.environmentId, outcome.changes);
  }
  logUnappliedEnvironmentLifecycleEvent(deps.logger, args, outcome);
  return outcome;
}

export async function applyLoggedEnvironmentLifecycleEventInTransaction(
  deps: ApplyLoggedEnvironmentLifecycleEventTransactionDeps,
  args: ApplyEnvironmentLifecycleEventArgs,
): Promise<ApplyEnvironmentLifecycleEventOutcome> {
  const outcome = await applyEnvironmentLifecycleEventInTransaction(
    deps.db,
    args,
  );
  logUnappliedEnvironmentLifecycleEvent(deps.logger, args, outcome);
  return outcome;
}
