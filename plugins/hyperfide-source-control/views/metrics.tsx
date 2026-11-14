import { Receipt } from "./shared.js";

type Sample = {
  coverage: string;
  observed_rows: number;
  bytes: string | null;
  states: Record<string, number>;
  maximum_observed_pending_age_ms: number | null;
  mean_observed_duration_ms: number | null;
  partitions: Record<string, number>;
  queue_depth: number | null;
  graph_work_items: number | null;
  remote_lag_ms: number | null;
};
type ProductSeries = {
  labels: { mode: string; status: string; partition: string };
  counters: Record<string, number>;
  gauges: Record<string, number>;
  checkpointLatency: {
    count: number;
    sumMs: number;
    buckets: { le: string; count: number }[];
  };
};
type Snapshot = {
  host?: {
    mode: string;
    cache: {
      files: number;
      bytes: number;
      complete: boolean;
      counters: Record<string, number> | null;
    };
    materialized: { files: number; bytes: number; complete: boolean } | null;
    dirty: { journal_paths: number; pending_checkpoint: boolean };
  };
  requests?: {
    activeRequests: number;
    maximumConcurrent: number;
    reservedRecoveryRequests: number;
    product?: ProductSeries[];
    counters: {
      action: string;
      outcome: string;
      count: number;
      durationMs: number;
      acknowledgedContentBytes: number;
      mode?: string;
      status?: string;
      partition?: string;
    }[];
  };
  source?: {
    observed_at: string;
    sample_budget: number;
    families: Record<string, Sample>;
  };
};
export function SourceMetricsView({ value }: { value: unknown }) {
  const snapshot = value as Snapshot | undefined;
  if (!snapshot) return <p>Loading source metrics…</p>;
  return (
    <section className="space-y-4">
      <h2 className="font-semibold">Source activity and storage</h2>
      {snapshot.host && (
        <article className="rounded-lg border border-border p-4 space-y-2">
          <h3 className="font-medium">Host workspace · {snapshot.host.mode}</h3>
          <p>
            Cache: {snapshot.host.cache.files} files ·{" "}
            {snapshot.host.cache.bytes} bytes ·{" "}
            {snapshot.host.cache.complete ? "complete" : "partial"} inventory
          </p>
          {snapshot.host.materialized && (
            <p>
              Materialized: {snapshot.host.materialized.files} files ·{" "}
              {snapshot.host.materialized.bytes} bytes ·{" "}
              {snapshot.host.materialized.complete ? "complete" : "partial"}{" "}
              inventory
            </p>
          )}
          <p>
            Dirty journal: {snapshot.host.dirty.journal_paths} paths ·
            checkpoint{" "}
            {snapshot.host.dirty.pending_checkpoint
              ? "awaiting acknowledgment"
              : "idle"}
          </p>
          {snapshot.host.cache.counters ? (
            <ul>
              {Object.entries(snapshot.host.cache.counters).map(
                ([name, count]) => (
                  <li key={name}>
                    {name}: {count}
                  </li>
                ),
              )}
            </ul>
          ) : (
            <p>Host cache counters unavailable</p>
          )}
        </article>
      )}
      {snapshot.requests && (
        <div className="rounded-lg border border-border p-4 space-y-2">
          <h3 className="font-medium">Product requests</h3>
          <p>
            {snapshot.requests.activeRequests} active /{" "}
            {snapshot.requests.maximumConcurrent} concurrent ·{" "}
            {snapshot.requests.reservedRecoveryRequests} slots reserved for
            recovery
          </p>
          <ul>
            {snapshot.requests.counters.map((counter) => (
              <li
                key={[
                  counter.action,
                  counter.outcome,
                  counter.mode,
                  counter.partition,
                ].join(":")}
              >
                {counter.action} · {counter.outcome} ·{" "}
                {counter.mode ?? "UNKNOWN"} · {counter.partition ?? "REQUEST"}:{" "}
                {counter.count} requests · mean{" "}
                {(counter.durationMs / Math.max(1, counter.count)).toFixed(1)}{" "}
                ms · {counter.acknowledgedContentBytes} acknowledged bytes
              </li>
            ))}
          </ul>
          {snapshot.requests.product?.map((series) => (
            <article
              key={Object.values(series.labels).join(":")}
              className="space-y-2"
            >
              <h4>
                {series.labels.mode} · {series.labels.status} ·{" "}
                {series.labels.partition}
              </h4>
              <dl className="grid gap-1 sm:grid-cols-2">
                {Object.entries({ ...series.counters, ...series.gauges }).map(
                  ([name, count]) => (
                    <div key={name}>
                      <dt className="inline">
                        {name.replace(/([A-Z])/g, " $1").toLowerCase()}:{" "}
                      </dt>
                      <dd className="inline">{count}</dd>
                    </div>
                  ),
                )}
              </dl>
              <p>
                Checkpoint latency: {series.checkpointLatency.count}{" "}
                observations · {series.checkpointLatency.sumMs.toFixed(1)} ms
                total
              </p>
              <ul>
                {series.checkpointLatency.buckets.map((bucket) => (
                  <li key={bucket.le}>
                    ≤ {bucket.le} ms: {bucket.count}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      )}
      {snapshot.source && (
        <>
          <p className="text-sm text-muted-foreground">
            Observed {snapshot.source.observed_at}. Each family samples up to{" "}
            {snapshot.source.sample_budget} records; partial observations are
            not repository totals.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {Object.entries(snapshot.source.families).map(([name, sample]) => (
              <article
                key={name}
                className="rounded-lg border border-border p-4 space-y-2"
              >
                <h3 className="font-medium capitalize">{name}</h3>
                <p>
                  {sample.coverage === "UNAVAILABLE"
                    ? "Not available"
                    : `${sample.observed_rows} observed records · ${sample.coverage.toLowerCase()} coverage`}
                </p>
                {sample.bytes !== null && <p>{sample.bytes} observed bytes</p>}
                {sample.maximum_observed_pending_age_ms !== null && (
                  <p>
                    Oldest observed pending:{" "}
                    {(sample.maximum_observed_pending_age_ms / 1000).toFixed(1)}{" "}
                    seconds
                  </p>
                )}
                {sample.mean_observed_duration_ms !== null && (
                  <p>
                    Mean observed duration:{" "}
                    {sample.mean_observed_duration_ms.toFixed(1)} ms
                  </p>
                )}
                {sample.queue_depth != null && (
                  <p>
                    Transfer queue depth: {sample.queue_depth} observed work
                    items
                  </p>
                )}
                {sample.graph_work_items != null && (
                  <p>
                    Graph work items: {sample.graph_work_items} observed pending
                    items
                  </p>
                )}
                {sample.remote_lag_ms != null && (
                  <p>
                    Remote lag: {(sample.remote_lag_ms / 1000).toFixed(1)}{" "}
                    seconds (oldest observed pending publication)
                  </p>
                )}
                <ul>
                  {Object.entries(sample.states).map(([state, count]) => (
                    <li key={state}>
                      {state}: {count}
                    </li>
                  ))}
                </ul>
                {Object.keys(sample.partitions).length > 0 && (
                  <p>
                    Storage partition:{" "}
                    {Object.entries(sample.partitions)
                      .map(([partition, count]) => `${partition}: ${count}`)
                      .join(" · ")}
                  </p>
                )}
              </article>
            ))}
          </div>
        </>
      )}
      <Receipt value={value} />
    </section>
  );
}
