/** Additive lifecycle capability for plugins that suspend work on external input. */
export interface ThreadAskLifecycle {
  pause(threadId: string, reason: AskPauseReason): Promise<void>;
  resume(threadId: string, message: string): Promise<void>;
  annotate(threadId: string, annotation: AskRecommendation): Promise<void>;
}

export interface AskPauseReason {
  askId: string;
  task: string;
  reason: string;
}

export interface AskRecommendation {
  askId: string;
  task: string;
  flagged: true;
  recommendation: string;
}

/** Adapt the existing SDK interrupt/send operations without changing plugin APIs. */
export function createThreadAskLifecycle(operations: {
  stop(threadId: string): Promise<void>;
  send(threadId: string, message: string): Promise<void>;
  record(threadId: string, event: AskPauseReason | AskRecommendation | { resumed: true }): Promise<void>;
}): ThreadAskLifecycle {
  return {
    async pause(threadId, reason) {
      await operations.record(threadId, reason);
      await operations.stop(threadId);
    },
    async resume(threadId, message) {
      await operations.send(threadId, message);
      await operations.record(threadId, { resumed: true });
    },
    async annotate(threadId, annotation) {
      await operations.record(threadId, annotation);
    },
  };
}
