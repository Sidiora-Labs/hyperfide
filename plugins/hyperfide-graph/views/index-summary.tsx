import type { ReactNode } from "react";
import {
  ResourceDetailCollection,
  ResourceStatus,
  type ResourceStatusTone,
} from "@/components/ui/resource-list";
import type { GraphResult } from "../contract.js";

function text(value: unknown, fallback = "Unknown"): string {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function count(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function statusTone(status: string): ResourceStatusTone {
  const normalized = status.toLowerCase();
  if (["ready", "fresh", "ok", "indexed", "current"].includes(normalized))
    return "success";
  if (["stale", "indexing", "partial", "pending"].includes(normalized))
    return "warning";
  if (["error", "failed", "missing"].includes(normalized)) return "error";
  return "muted";
}

export function DefinitionRow({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-4 px-3 py-2 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd
        className={`min-w-0 truncate text-right text-foreground ${mono ? "font-mono text-xs" : ""}`}
      >
        {children}
      </dd>
    </div>
  );
}

export function IndexView({ result }: { result: GraphResult }) {
  const data = result.data;
  const status = text(data.status);
  const staleAnchors = count(data.stale_anchors);
  return (
    <ResourceDetailCollection>
      <dl className="divide-y divide-border">
        <DefinitionRow label="Status">
          <ResourceStatus tone={statusTone(status)}>{status}</ResourceStatus>
        </DefinitionRow>
        <DefinitionRow label="Last pass">{text(data.last_pass)}</DefinitionRow>
        <DefinitionRow label="Symbols">
          {text(data.symbols ?? data.symbol_count)}
        </DefinitionRow>
        <DefinitionRow label="Files">
          {text(data.files ?? data.file_count)}
        </DefinitionRow>
        <DefinitionRow label="Stale anchors">
          {staleAnchors === null ? (
            text(data.stale_anchors)
          ) : (
            <ResourceStatus tone={staleAnchors > 0 ? "warning" : "success"}>
              {staleAnchors}
            </ResourceStatus>
          )}
        </DefinitionRow>
        <DefinitionRow label="Binary" mono>
          {result.binary.version} · {result.binary.digest.slice(0, 12)}
        </DefinitionRow>
      </dl>
    </ResourceDetailCollection>
  );
}
