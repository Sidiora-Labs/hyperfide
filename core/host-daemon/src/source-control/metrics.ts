export const SOURCE_METRIC_ACTIONS = [
  "read",
  "open",
  "checkpoint",
  "submit",
  "qualify",
  "accept",
  "transform",
  "publish",
  "resume",
  "cancel",
] as const;
export type SourceMetricAction = (typeof SOURCE_METRIC_ACTIONS)[number];
export type SourceMetricOutcome = "success" | "rejected" | "unknown";
export class SourceMetrics {
  private readonly counters = new Map<
    string,
    { count: number; durationMs: number; acknowledgedContentBytes: number }
  >();
  private active = 0;
  constructor(private readonly maximumConcurrent = 16) {
    if (
      !Number.isSafeInteger(maximumConcurrent) ||
      maximumConcurrent < 2 ||
      maximumConcurrent > 256
    )
      throw new Error("Invalid source request budget");
  }
  admit(action: SourceMetricAction): () => void {
    const reserved = action === "cancel" || action === "resume";
    if (this.active >= this.maximumConcurrent - (reserved ? 0 : 2))
      throw Object.assign(
        new Error("Source request budget is busy; retry the same operation"),
        { code: "OVERLOADED", retry: "RETRY_SAME_OPERATION", outcome: "KNOWN" },
      );
    this.active++;
    let released = false;
    return () => {
      if (!released) {
        this.active--;
        released = true;
      }
    };
  }
  record(
    action: SourceMetricAction,
    outcome: SourceMetricOutcome,
    elapsed: number,
    acknowledgedContentBytes = 0,
  ): void {
    if (
      !SOURCE_METRIC_ACTIONS.includes(action) ||
      !["success", "rejected", "unknown"].includes(outcome) ||
      !Number.isFinite(elapsed) ||
      elapsed < 0 ||
      !Number.isSafeInteger(acknowledgedContentBytes) ||
      acknowledgedContentBytes < 0
    )
      throw new Error("Invalid source metric");
    const key = action + ":" + outcome,
      old = this.counters.get(key) ?? {
        count: 0,
        durationMs: 0,
        acknowledgedContentBytes: 0,
      };
    this.counters.set(key, {
      count: old.count + 1,
      durationMs: old.durationMs + elapsed,
      acknowledgedContentBytes:
        old.acknowledgedContentBytes + acknowledgedContentBytes,
    });
  }
  snapshot() {
    return {
      activeRequests: this.active,
      maximumConcurrent: this.maximumConcurrent,
      reservedRecoveryRequests: 2,
      counters: [...this.counters].map(([key, value]) => {
        const [action, outcome] = key.split(":");
        return { action, outcome, ...value };
      }),
    };
  }
}
