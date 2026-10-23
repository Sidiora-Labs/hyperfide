import type { AskRecommendation } from "../../../packages/plugin-sdk/src/thread-ask-lifecycle.js";

/** Board models consume the same annotations as the thread timeline. */
export class AskTaskFlags {
  private readonly tasks = new Map<string, Map<string, AskRecommendation>>();

  annotate(repository: string, annotation: AskRecommendation): void {
    const key = JSON.stringify([repository, annotation.task]);
    const flags = this.tasks.get(key) ?? new Map<string, AskRecommendation>();
    flags.set(annotation.askId, annotation);
    this.tasks.set(key, flags);
  }

  forTask(repository: string, task: string) {
    const annotations = [...(this.tasks.get(JSON.stringify([repository, task]))?.values() ?? [])];
    return { flagged: annotations.length > 0, annotations };
  }
}
