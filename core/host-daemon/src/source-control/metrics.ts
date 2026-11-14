import { SourceControlError } from "@hyperfide/source-control";

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
export const SOURCE_METRIC_MODES = [
  "API_ONLY",
  "SPARSE",
  "MATERIALIZED",
  "VIRTUAL",
  "UNKNOWN",
] as const;
export const SOURCE_METRIC_STATUSES = [
  "success",
  "rejected",
  "unknown",
] as const;
export const SOURCE_METRIC_PARTITIONS = [
  "REQUEST",
  "CACHE",
  "OVERLAY",
  "TRANSFER",
  "GRAPH",
  "INTEGRATION",
  "REMOTE",
] as const;
export type SourceMetricOutcome = (typeof SOURCE_METRIC_STATUSES)[number];
export type SourceMetricLabels = {
  mode: (typeof SOURCE_METRIC_MODES)[number];
  status: SourceMetricOutcome;
  partition: (typeof SOURCE_METRIC_PARTITIONS)[number];
};
export const SOURCE_PRODUCT_COUNTERS = [
  "logicalOpens",
  "materializationBytes",
  "materializationFiles",
  "cacheHits",
  "cacheMisses",
  "cacheEvictions",
  "downloadBytes",
  "graphWorkItems",
  "integrationRetries",
] as const;
export const SOURCE_PRODUCT_GAUGES = [
  "dirtyBytes",
  "transferQueueDepth",
  "remoteLagMs",
] as const;
export const SOURCE_CHECKPOINT_BUCKETS_MS = [
  10, 50, 100, 500, 1000, 5000, 30000,
] as const;
const defaults: SourceMetricLabels = {
  mode: "UNKNOWN",
  status: "success",
  partition: "REQUEST",
};
function labelsKey(labels: SourceMetricLabels): string {
  if (
    Object.keys(labels).length !== 3 ||
    !SOURCE_METRIC_MODES.includes(labels.mode) ||
    !SOURCE_METRIC_STATUSES.includes(labels.status) ||
    !SOURCE_METRIC_PARTITIONS.includes(labels.partition)
  )
    throw new Error(
      "Source metrics require bounded mode, status and partition labels",
    );
  return `${labels.mode}:${labels.status}:${labels.partition}`;
}
function amount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Source metric requires a nonnegative safe integer");
}
export class SourceBudgetExceeded extends SourceControlError {
  constructor(
    readonly budget: "concurrent_requests" | "recovery_requests",
    readonly limit: number,
  ) {
    super(
      "LIMIT_EXCEEDED",
      `Source ${budget} budget (${limit}) is busy; retry the same operation`,
      "RETRY_SAME_OPERATION",
      "KNOWN",
      { budget, limit },
    );
  }
}
export class SourceMetrics {
  private readonly counters = new Map<
    string,
    {
      action: SourceMetricAction;
      outcome: SourceMetricOutcome;
      mode: SourceMetricLabels["mode"];
      status: SourceMetricOutcome;
      partition: SourceMetricLabels["partition"];
      count: number;
      durationMs: number;
      acknowledgedContentBytes: number;
    }
  >();
  private readonly product = new Map<
    string,
    {
      labels: SourceMetricLabels;
      counters: Record<(typeof SOURCE_PRODUCT_COUNTERS)[number], number>;
      gauges: Record<(typeof SOURCE_PRODUCT_GAUGES)[number], number>;
      checkpointLatency: { count: number; sumMs: number; buckets: number[] };
    }
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
    if (!SOURCE_METRIC_ACTIONS.includes(action))
      throw new Error("Invalid source metric action");
    const reserved = action === "cancel" || action === "resume";
    if (this.active >= this.maximumConcurrent - (reserved ? 0 : 2))
      throw new SourceBudgetExceeded(
        reserved ? "recovery_requests" : "concurrent_requests",
        this.maximumConcurrent - (reserved ? 0 : 2),
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
  private series(labels: SourceMetricLabels) {
    const key = labelsKey(labels);
    let series = this.product.get(key);
    if (!series) {
      series = {
        labels: { ...labels },
        counters: {
          logicalOpens: 0,
          materializationBytes: 0,
          materializationFiles: 0,
          cacheHits: 0,
          cacheMisses: 0,
          cacheEvictions: 0,
          downloadBytes: 0,
          graphWorkItems: 0,
          integrationRetries: 0,
        },
        gauges: { dirtyBytes: 0, transferQueueDepth: 0, remoteLagMs: 0 },
        checkpointLatency: {
          count: 0,
          sumMs: 0,
          buckets: SOURCE_CHECKPOINT_BUCKETS_MS.map(() => 0),
        },
      };
      this.product.set(key, series);
    }
    return series;
  }
  increment(
    metric: (typeof SOURCE_PRODUCT_COUNTERS)[number],
    value = 1,
    labels: SourceMetricLabels = defaults,
  ): void {
    if (!SOURCE_PRODUCT_COUNTERS.includes(metric))
      throw new Error("Invalid source counter");
    amount(value);
    const series = this.series(labels);
    series.counters[metric] = Math.min(
      Number.MAX_SAFE_INTEGER,
      series.counters[metric] + value,
    );
  }
  gauge(
    metric: (typeof SOURCE_PRODUCT_GAUGES)[number],
    value: number,
    labels: SourceMetricLabels = defaults,
  ): void {
    if (!SOURCE_PRODUCT_GAUGES.includes(metric))
      throw new Error("Invalid source gauge");
    amount(value);
    this.series(labels).gauges[metric] = value;
  }
  adjustGauge(
    metric: (typeof SOURCE_PRODUCT_GAUGES)[number],
    delta: number,
    labels: SourceMetricLabels = defaults,
  ): void {
    if (!Number.isSafeInteger(delta))
      throw new Error("Invalid source gauge delta");
    this.gauge(metric, this.series(labels).gauges[metric] + delta, labels);
  }
  record(
    action: SourceMetricAction,
    outcome: SourceMetricOutcome,
    elapsed: number,
    acknowledgedContentBytes = 0,
    labels: SourceMetricLabels = { ...defaults, status: outcome },
  ): void {
    if (
      !SOURCE_METRIC_ACTIONS.includes(action) ||
      !SOURCE_METRIC_STATUSES.includes(outcome) ||
      !Number.isFinite(elapsed) ||
      elapsed < 0 ||
      labels.status !== outcome
    )
      throw new Error("Invalid source metric");
    amount(acknowledgedContentBytes);
    const key = action + ":" + labelsKey(labels);
    const old = this.counters.get(key) ?? {
      action,
      outcome,
      ...labels,
      count: 0,
      durationMs: 0,
      acknowledgedContentBytes: 0,
    };
    this.counters.set(key, {
      ...old,
      count: old.count + 1,
      durationMs: old.durationMs + elapsed,
      acknowledgedContentBytes:
        old.acknowledgedContentBytes + acknowledgedContentBytes,
    });
    if (action === "open" && outcome === "success")
      this.increment("logicalOpens", 1, labels);
    if (action === "checkpoint") {
      const histogram = this.series(labels).checkpointLatency;
      histogram.count++;
      histogram.sumMs += elapsed;
      SOURCE_CHECKPOINT_BUCKETS_MS.forEach((bound, index) => {
        if (elapsed <= bound) histogram.buckets[index]!++;
      });
    }
  }
  snapshot() {
    return {
      activeRequests: this.active,
      maximumConcurrent: this.maximumConcurrent,
      reservedRecoveryRequests: 2,
      counters: [...this.counters.values()].map((value) => ({ ...value })),
      product: [...this.product.values()].map((series) => ({
        labels: { ...series.labels },
        counters: { ...series.counters },
        gauges: { ...series.gauges },
        checkpointLatency: {
          count: series.checkpointLatency.count,
          sumMs: series.checkpointLatency.sumMs,
          buckets: [
            ...SOURCE_CHECKPOINT_BUCKETS_MS.map((le, i) => ({
              le: String(le),
              count: series.checkpointLatency.buckets[i]!,
            })),
            { le: "+Inf", count: series.checkpointLatency.count },
          ],
        },
      })),
    };
  }
}
export const hostSourceMetrics = new SourceMetrics();
