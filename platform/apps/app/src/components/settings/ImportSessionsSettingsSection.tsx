import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@hyperfide/shared-ui/button";
import { Icon } from "@hyperfide/shared-ui/icon";
import { SettingsSection } from "@/components/ui/settings-section";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { invalidateThreadListQueries } from "@/hooks/cache-owners/mutation-cache-effects";

export interface SessionImportSource {
  source: "claude-code" | "codex";
  root: string;
  count: number;
}

export interface SessionImportResult {
  imported: number;
  updated: number;
  records: number;
  errors: { path: string; message: string }[];
}

interface ImportSessionsContentProps {
  sources: SessionImportSource[];
  loading?: boolean;
  importing?: boolean;
  error?: string;
  result?: SessionImportResult;
  onImport: () => void;
  onRefresh: () => void;
}

export function ImportSessionsSettingsContent({
  sources,
  loading = false,
  importing = false,
  error,
  result,
  onImport,
  onRefresh,
}: ImportSessionsContentProps) {
  return (
    <SettingsSection
      title="Import sessions"
      description="Continue prior Claude Code and Codex sessions from this machine in Hyperfide. Import again to pick up new messages."
      bodyClassName="overflow-hidden p-0"
      actionPlacement="inline"
      action={
        <Button
          size="sm"
          disabled={
            loading ||
            importing ||
            sources.every((source) => source.count === 0)
          }
          onClick={onImport}
        >
          {importing ? (
            <Icon
              name="Loading"
              className="size-3.5 animate-spin"
              aria-hidden
            />
          ) : null}
          {importing ? "Importing" : "Import"}
        </Button>
      }
    >
      <div className="divide-y divide-border">
        {sources.map((source) => (
          <div
            key={`${source.source}:${source.root}`}
            className="flex min-w-0 items-start gap-3 px-4 py-3.5 text-sm"
          >
            <Icon
              name="MessageSquare"
              className="mt-0.5 size-4 shrink-0 text-subtle-foreground"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {source.source === "claude-code" ? "Claude Code" : "Codex"}
              </p>
              <p className="break-all text-xs text-subtle-foreground">
                {source.root}
              </p>
            </div>
            <span className="shrink-0 text-xs text-subtle-foreground">
              {source.count} sessions
            </span>
          </div>
        ))}
        {loading ? (
          <p
            role="status"
            className="px-4 py-3.5 text-sm text-subtle-foreground"
          >
            Discovering sessions...
          </p>
        ) : null}
        {!loading && sources.length === 0 ? (
          <p className="px-4 py-3.5 text-sm text-subtle-foreground">
            No session sources found on this machine.
          </p>
        ) : null}
      </div>
      <div className="space-y-2 border-t border-border px-4 py-3 text-xs text-subtle-foreground">
        {importing ? (
          <p role="status">
            Importing session history. This can take a moment for large
            archives.
          </p>
        ) : null}
        {result ? (
          <p role="status">
            Imported {result.imported} sessions, updated {result.updated}{" "}
            sessions and added {result.records} records.
          </p>
        ) : null}
        {result?.errors.map((failure) => (
          <p key={failure.path} className="break-words text-destructive">
            {failure.path}: {failure.message}
          </p>
        ))}
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          disabled={loading || importing}
          onClick={onRefresh}
        >
          Refresh sources
        </Button>
      </div>
    </SettingsSection>
  );
}

async function importRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithAppSurface(path, init);
  if (!response.ok)
    throw new Error(`Session import request failed (${response.status}).`);
  return response.json() as Promise<T>;
}

export function ImportSessionsSettingsSection() {
  const queryClient = useQueryClient();
  const sources = useQuery({
    queryKey: ["session-import-sources"],
    queryFn: () =>
      importRequest<{ sources: SessionImportSource[] }>(
        "/api/v1/threads/import/sources",
      ),
  });
  const importer = useMutation({
    mutationFn: () =>
      importRequest<SessionImportResult>("/api/v1/threads/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    onSuccess: () => {
      invalidateThreadListQueries({ queryClient });
      void sources.refetch();
    },
  });
  return (
    <ImportSessionsSettingsContent
      sources={sources.data?.sources ?? []}
      loading={sources.isPending}
      importing={importer.isPending}
      error={(importer.error ?? sources.error)?.message}
      result={importer.data}
      onImport={() => importer.mutate()}
      onRefresh={() => {
        void sources.refetch();
      }}
    />
  );
}
