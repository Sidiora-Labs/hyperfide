import { Icon } from "@/components/ui/icon";
import { ResourceDetailPanel } from "@/components/ui/resource-list";
import type { GraphResult } from "../contract.js";

export function SurveyViewer({
  data,
  binary,
  target,
}: {
  data: Record<string, unknown>;
  binary?: GraphResult["binary"];
  target?: string;
}) {
  const keys = Object.keys(data);
  return (
    <ResourceDetailPanel
      surface="flat"
      className="rounded-md border border-border bg-background"
    >
      <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-relaxed text-foreground">
        {JSON.stringify(data, null, 2)}
      </pre>
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border bg-surface-recessed/55 px-3 py-2 text-xs text-muted-foreground">
        {target ? (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <Icon name="Target" className="size-3.5 shrink-0" aria-hidden />
            <span className="max-w-64 truncate">{target}</span>
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1.5">
          <Icon name="Layers" className="size-3.5" aria-hidden />
          {keys.length} {keys.length === 1 ? "field" : "fields"}
        </span>
        {binary ? (
          <span className="inline-flex items-center gap-1.5">
            <Icon name="Terminal" className="size-3.5" aria-hidden />
            {binary.version}
          </span>
        ) : null}
      </div>
    </ResourceDetailPanel>
  );
}
