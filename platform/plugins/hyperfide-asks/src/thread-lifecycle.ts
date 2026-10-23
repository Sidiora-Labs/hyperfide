import type { ThreadAskLifecycle } from "@hyperfide/plugin-sdk/host";
import type { AskTaskFlags } from "../../hyperfide-spec/src/ask-task-flags.js";
import type { AskBridge, Ask as AskRow } from "./bridge.js";

export interface TaskThreads {
  list(repository: string): Promise<readonly { id: string; repository: string; task: string }[]>;
}

interface ThreadState {
  pending: Map<string, AskRow>;
  answers: Map<string, string>;
  seen: Set<string>;
}

/** One instance per repository; snapshots and watch notifications share a serial queue. */
export class AskThreadLifecycle {
  private readonly states = new Map<string, ThreadState>();
  private queue: Promise<void> = Promise.resolve();
  private unwatch?: () => void;

  constructor(
    private readonly repository: string,
    private readonly bridge: Pick<AskBridge, "policy" | "list" | "watch">,
    private readonly threads: TaskThreads,
    private readonly lifecycle: ThreadAskLifecycle,
    private readonly board: AskTaskFlags,
  ) {}

  async start(onError: (error: unknown) => void): Promise<void> {
    this.unwatch = await this.bridge.watch(this.repository, () => {
      void this.sync().catch(onError);
    });
    await this.sync();
  }

  async dispose(): Promise<void> {
    this.unwatch?.();
    this.unwatch = undefined;
    await this.queue;
  }

  sync(): Promise<void> {
    const next = this.queue.then(() => this.reconcile());
    this.queue = next.catch(() => {});
    return next;
  }

  private async reconcile(): Promise<void> {
    const policies = await this.bridge.policy(this.repository);
    const rows = await this.bridge.list(this.repository);
    const threads = (await this.threads.list(this.repository))
      .filter(thread => thread.repository === this.repository);

    for (const row of rows) {
      const policy = policies[row.kind];
      if (!policy || !["block", "proceed-and-flag"].includes(policy)) {
        throw new Error(`Missing Ask policy for ${row.kind}`);
      }
      const candidates = threads.filter(thread => thread.task === row.task);
      const session = candidates.find(thread => thread.id === row.session);
      const matches = session ? [session] : candidates;
      for (const thread of matches) {
        const state = this.states.get(thread.id) ?? {
          pending: new Map<string, AskRow>(), answers: new Map<string, string>(), seen: new Set<string>(),
        };
        this.states.set(thread.id, state);
        const id = String(row.id);
        if (state.seen.has(id)) continue;
        if (row.status === "open" || (row.status === "expired" && policy === "block")) {
          if (policy === "block") {
            if (!state.pending.has(id)) {
              await this.lifecycle.pause(thread.id, {
                askId: id, task: thread.task, reason: `Awaiting Ask ${id}: ${row.question}`,
              });
              state.pending.set(id, row);
            }
          } else {
            if (!row.recommendation) throw new Error(`Ask ${id} has no recommendation`);
            const annotation = {
              askId: id, task: thread.task, flagged: true as const, recommendation: row.recommendation,
            };
            await this.lifecycle.annotate(thread.id, annotation);
            this.board.annotate(this.repository, annotation);
            state.seen.add(id);
          }
        } else if (state.pending.has(id) && row.status === "answered") {
          // Never serialize the row: secret answers may contain a raw value from the store.
          const answer = row.kind === "secret"
            ? this.secretReference(row)
            : typeof row.answer === "string" ? row.answer : null;
          if (answer == null) throw new Error(`Ask ${id} has no answer`);
          state.answers.set(id, `Ask ${id} answered: ${answer}`);
          state.pending.delete(id);
        }
      }
    }

    // Answering one of several blocking Asks must not restart a still-blocked thread.
    for (const [threadId, state] of this.states) {
      if (state.pending.size === 0 && state.answers.size > 0) {
        await this.lifecycle.resume(threadId, [...state.answers.values()].join("\n"));
        for (const id of state.answers.keys()) state.seen.add(id);
        state.answers.clear();
      }
    }
  }

  private secretReference(row: AskRow): string {
    const reference = typeof row.secret_ref === "string" ? row.secret_ref : (typeof row.answer === "string" && row.answer.startsWith("secret-ref:") ? row.answer.slice(11) : null);
    if (!reference || !/^[A-Za-z0-9_.\/-]+$/.test(reference)) {
      throw new Error(`Ask ${row.id} has no secret reference`);
    }
    return `secret-ref:${reference}`;
  }
}
