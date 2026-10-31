import { listLatestThreadStateEventRowsByThreadIds } from "@hyperfide/db";
import type { DbConnection } from "@hyperfide/db";
import {
  THREAD_SESSION_OPTIONS_STATE_KIND,
  THREAD_SESSION_OPTION_SELECTIONS_STATE_KIND,
  applySessionOptionSelectionPatch,
  pendingSessionOptionSelections,
  threadScope,
  threadSessionOptionSelectionsStateSchema,
  threadSessionOptionsStateSchema,
  type SessionOptionSelectionPatch,
  type SessionOptionSelections,
  type Thread,
  type ThreadSessionOption,
} from "@hyperfide/domain";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { decodeStoredEventRowCached } from "./stored-event-decode-cache.js";
import { appendThreadEvent } from "./thread-events.js";

interface ThreadStateSnapshot {
  payload: unknown;
  providerThreadId: string;
}

interface ThreadSessionOptionState {
  options: ThreadSessionOption[];
  optionsReported: boolean;
  providerThreadId: string | null;
  selections: SessionOptionSelections;
}

async function readLatestThreadState(
  db: DbConnection,
  threadId: string,
  kind:
    | typeof THREAD_SESSION_OPTIONS_STATE_KIND
    | typeof THREAD_SESSION_OPTION_SELECTIONS_STATE_KIND,
): Promise<ThreadStateSnapshot | null> {
  for (const row of await listLatestThreadStateEventRowsByThreadIds(db, {
    threadIds: [threadId],
    kind,
  })) {
    const event = decodeStoredEventRowCached(db, row);
    if (event.type === "thread/extensionState/updated" && event.kind === kind) {
      return {
        payload: event.payload,
        providerThreadId: event.providerThreadId,
      };
    }
  }
  return null;
}

async function readThreadSessionOptionState(
  db: DbConnection,
  threadId: string,
): Promise<ThreadSessionOptionState> {
  const optionsSnapshot = await readLatestThreadState(
    db,
    threadId,
    THREAD_SESSION_OPTIONS_STATE_KIND,
  );
  const options = threadSessionOptionsStateSchema.safeParse(
    optionsSnapshot?.payload,
  );
  const selections = threadSessionOptionSelectionsStateSchema.safeParse(
    (
      await readLatestThreadState(
        db,
        threadId,
        THREAD_SESSION_OPTION_SELECTIONS_STATE_KIND,
      )
    )?.payload,
  );
  return {
    options: options.success ? options.data.options : [],
    optionsReported: optionsSnapshot !== null,
    providerThreadId: optionsSnapshot?.providerThreadId ?? null,
    selections: selections.success ? selections.data.selections : {},
  };
}

function sameSelections(
  left: SessionOptionSelections,
  right: SessionOptionSelections,
): boolean {
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every(
      (key) => Object.hasOwn(right, key) && left[key] === right[key],
    )
  );
}

export async function seedThreadSessionOptionSelections(
  deps: Pick<AppDeps, "db" | "hub">,
  args: { thread: Thread; selections: SessionOptionSelections },
): Promise<void> {
  if (Object.keys(args.selections).length === 0) {
    return;
  }
  await writeThreadSessionOptionSelections(deps, {
    threadId: args.thread.id,
    environmentId: args.thread.environmentId,
    providerThreadId: "",
    selections: args.selections,
  });
}

async function writeThreadSessionOptionSelections(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    threadId: string;
    environmentId: string | null;
    providerThreadId: string;
    selections: SessionOptionSelections;
  },
): Promise<void> {
  await appendThreadEvent(deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    type: "thread/extensionState/updated",
    scope: threadScope(),
    data: {
      providerThreadId: args.providerThreadId,
      kind: THREAD_SESSION_OPTION_SELECTIONS_STATE_KIND,
      payload: { selections: args.selections },
    },
  });
}

export async function resolvePendingThreadSessionOptions(
  db: DbConnection,
  threadId: string,
): Promise<SessionOptionSelections> {
  const state = await readThreadSessionOptionState(db, threadId);
  return state.optionsReported
    ? pendingSessionOptionSelections(state.options, state.selections)
    : state.selections;
}

export async function applyThreadSessionOptionPatch(
  deps: Pick<AppDeps, "db" | "hub">,
  args: { thread: Thread; patch: SessionOptionSelectionPatch },
): Promise<void> {
  const state = await readThreadSessionOptionState(deps.db, args.thread.id);
  const result = applySessionOptionSelectionPatch({
    options: state.options,
    selections: state.selections,
    patch: args.patch,
  });
  if (!result.ok) {
    throw new ApiError(400, "invalid_request", result.message);
  }
  if (
    state.providerThreadId === null ||
    sameSelections(state.selections, result.selections)
  ) {
    return;
  }
  await writeThreadSessionOptionSelections(deps, {
    threadId: args.thread.id,
    environmentId: args.thread.environmentId,
    providerThreadId: state.providerThreadId,
    selections: result.selections,
  });
}

export async function dropSettledThreadSessionOptionSelections(
  deps: Pick<AppDeps, "db" | "hub">,
  args: { threadId: string; environmentId: string | null },
): Promise<void> {
  const state = await readThreadSessionOptionState(deps.db, args.threadId);
  if (state.providerThreadId === null) {
    return;
  }
  const pending = pendingSessionOptionSelections(
    state.options,
    state.selections,
  );
  if (sameSelections(state.selections, pending)) {
    return;
  }
  await writeThreadSessionOptionSelections(deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    providerThreadId: state.providerThreadId,
    selections: pending,
  });
}
