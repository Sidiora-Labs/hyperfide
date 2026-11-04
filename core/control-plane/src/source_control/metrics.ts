import { SourceControlError } from "./contracts.js";
import {
  SourceMetadata,
  sourceScopeValues,
  type SourceContext,
  type SourceSQL,
} from "./metadata.js";

type Row = Record<string, unknown>;
const millis = (value: unknown) =>
  value instanceof Date ? value.getTime() : Date.parse(String(value));
const tables = {
  objects: [
    "source_native_objects",
    "state,kind,size_bytes::text,tableoid::regclass::text AS partition",
  ],
  uploads: ["source_object_uploads", "status AS state"],
  operations: ["source_metadata_operations", "state,created_at,updated_at"],
  publications: [
    "source_git_publications",
    "status AS state,created_at,updated_at",
  ],
  graphs: ["source_graph_builds", "state"],
  transfers: [
    "source_transfers",
    "state,direction,size_bytes::text,created_at",
  ],
} as const;
export class SourceMetricsService {
  constructor(private readonly metadata: SourceMetadata) {}
  async read(context: SourceContext, input: { max_rows?: number } = {}) {
    const maximum = input.max_rows ?? 1024;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4096)
      throw new SourceControlError(
        "LIMIT_EXCEEDED",
        "Metrics sample budget must be between one and 4096 rows per family",
      );
    return this.metadata.transaction(async (tx) => {
      await this.metadata.guard(tx, context, "source.metrics.read");
      const nowRow = (await tx.query("SELECT clock_timestamp() AS observed_at"))
        .rows[0]!;
      const observedAt = new Date(millis(nowRow.observed_at)).toISOString();
      const families: Record<string, unknown> = {};
      for (const [family, [table, columns]] of Object.entries(tables))
        families[family] = await this.sample(
          tx,
          context,
          table,
          columns,
          maximum,
          Date.parse(observedAt),
        );
      return {
        schema_version: 1,
        scope: context.scope,
        observed_at: observedAt,
        sample_budget: maximum,
        semantics: "BOUNDED_OBSERVATIONS",
        families,
      };
    });
  }
  private async sample(
    tx: SourceSQL,
    context: SourceContext,
    table: string,
    columns: string,
    maximum: number,
    now: number,
  ) {
    const present = (
      await tx.query("SELECT to_regclass($1) IS NOT NULL AS present", [
        "hyperfide." + table,
      ])
    ).rows[0]?.present;
    if (!present)
      return {
        coverage: "UNAVAILABLE",
        observed_rows: 0,
        states: {},
        bytes: null,
        maximum_observed_age_ms: null,
        maximum_observed_pending_age_ms: null,
        mean_observed_duration_ms: null,
        partitions: {},
      };
    const result = await tx.query(
      `SELECT ${columns} FROM hyperfide.${table} WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 LIMIT $4`,
      [...sourceScopeValues(context.scope), maximum + 1],
    );
    const rows = result.rows.slice(0, maximum) as Row[],
      states: Record<string, number> = {},
      partitions: Record<string, number> = {};
    let bytes = 0n,
      hasBytes = false,
      maximumAge: number | null = null,
      pendingAge: number | null = null,
      durationTotal = 0,
      durationCount = 0;
    for (const row of rows) {
      const state = typeof row.state === "string" ? row.state : "UNKNOWN";
      states[state] = (states[state] ?? 0) + 1;
      if (typeof row.partition === "string")
        partitions[row.partition] = (partitions[row.partition] ?? 0) + 1;
      if (
        typeof row.size_bytes === "string" &&
        /^[0-9]+$/.test(row.size_bytes)
      ) {
        bytes += BigInt(row.size_bytes);
        hasBytes = true;
      }
      if (row.created_at) {
        const created = millis(row.created_at);
        if (Number.isFinite(created)) {
          maximumAge = Math.max(maximumAge ?? 0, Math.max(0, now - created));
          if (
            [
              "PENDING",
              "UPLOADING",
              "UNKNOWN",
              "QUEUED",
              "READY",
              "DISPATCHED",
              "OUTCOME_UNKNOWN",
              "BUILDING",
              "PREPARING",
              "ACTIVE",
              "FINALIZING",
            ].includes(state)
          )
            pendingAge = Math.max(pendingAge ?? 0, Math.max(0, now - created));
          if (row.updated_at && state !== "PENDING") {
            const updated = millis(row.updated_at);
            if (Number.isFinite(updated) && updated >= created) {
              durationTotal += updated - created;
              durationCount++;
            }
          }
        }
      }
    }
    return {
      coverage: result.rows.length > maximum ? "PARTIAL" : "COMPLETE",
      observed_rows: rows.length,
      states,
      bytes: hasBytes ? String(bytes) : null,
      maximum_observed_age_ms: maximumAge,
      maximum_observed_pending_age_ms: pendingAge,
      mean_observed_duration_ms: durationCount
        ? Math.round(durationTotal / durationCount)
        : null,
      partitions,
    };
  }
}
