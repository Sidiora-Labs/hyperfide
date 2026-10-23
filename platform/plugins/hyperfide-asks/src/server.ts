import { createThreadAskLifecycle } from "../../../packages/plugin-sdk/src/thread-ask-lifecycle.js";
import { AskTaskFlags } from "../../hyperfide-spec/src/ask-task-flags.js";
import { AskThreadLifecycle } from "./thread-lifecycle.js";
import type { AskBridge, TaskThreads } from "./task-3-2-projection.js";

/** Composition point for the 3.1 bridge and 2.3 worker-thread registry. */
export function createAskThreadService(args: {
  repository: string;
  bridge: AskBridge;
  threads: TaskThreads;
  operations: Parameters<typeof createThreadAskLifecycle>[0];
  board?: AskTaskFlags;
}) {
  const board = args.board ?? new AskTaskFlags();
  return {
    board,
    lifecycle: new AskThreadLifecycle(
      args.repository, args.bridge, args.threads, createThreadAskLifecycle(args.operations), board,
    ),
  };
}
