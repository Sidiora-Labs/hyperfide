import { NativeObjectCache as ObjectCache } from "@hyperfide/source-control/host";
import { hostSourceMetrics, type SourceMetrics } from "./metrics.js";
export type { CacheLimits, CachedObject } from "@hyperfide/source-control/host";

export class NativeObjectCache extends ObjectCache {
  private observed = { hits: 0, misses: 0, evictions: 0, downloaded_bytes: 0 };
  constructor(
    ...args: [
      ...ConstructorParameters<typeof ObjectCache>,
      productMetrics?: SourceMetrics,
    ]
  ) {
    super(args[0], args[1]);
    this.productMetrics = args[2] ?? hostSourceMetrics;
  }
  readonly productMetrics: SourceMetrics;
  override async acquire(...args: Parameters<ObjectCache["acquire"]>) {
    const labels = {
      mode: "UNKNOWN",
      status: "success",
      partition: "CACHE",
    } as const;
    this.productMetrics.adjustGauge("transferQueueDepth", 1, labels);
    try {
      return await super.acquire(...args);
    } finally {
      this.productMetrics.adjustGauge("transferQueueDepth", -1, labels);
      const current = super.metrics;
      for (const [field, counter] of [
        ["hits", "cacheHits"],
        ["misses", "cacheMisses"],
        ["evictions", "cacheEvictions"],
        ["downloaded_bytes", "downloadBytes"],
      ] as const) {
        this.productMetrics.increment(
          counter,
          current[field] - this.observed[field],
          labels,
        );
        this.observed[field] = current[field];
      }
    }
  }
}
