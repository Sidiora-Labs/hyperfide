import { Receipt } from "./shared.js";

type Sample = {
  coverage: string;
  observed_rows: number;
  bytes: string | null;
  states: Record<string, number>;
  maximum_observed_pending_age_ms: number | null;
  mean_observed_duration_ms: number | null;
  partitions: Record<string, number>;
};
type Snapshot = {
  requests?: {
    activeRequests: number;
    maximumConcurrent: number;
    reservedRecoveryRequests: number;
    counters: {
      action: string;
      outcome: string;
      count: number;
      durationMs: number;
      acknowledgedContentBytes: number;
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
              <li key={counter.action + counter.outcome}>
                {counter.action} · {counter.outcome}: {counter.count} requests ·
                mean{" "}
                {(counter.durationMs / Math.max(1, counter.count)).toFixed(1)}{" "}
                ms · {counter.acknowledgedContentBytes} acknowledged bytes
              </li>
            ))}
          </ul>
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
                <ul>
                  {Object.entries(sample.states).map(([state, count]) => (
                    <li key={state}>
                      {state}: {count}
                    </li>
                  ))}
                </ul>
                {Object.keys(sample.partitions).length > 0 && (
                  <p>
                    {Object.keys(sample.partitions).length} observed storage
                    partitions
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
