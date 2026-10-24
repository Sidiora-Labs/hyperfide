import { useEffect, useMemo, useState, type ReactNode } from "react";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import {
  ResourceCollectionPage,
  ResourceCollectionViewport,
  ResourceFilterMenu,
  ResourceListPanel,
  ResourceListState,
  ResourceToolbar,
} from "@/components/ui/resource-list";
import type { Ask, Kind } from "../src/inbox-adapter.js";
import { filterAsks, kinds } from "../src/inbox.js";
import { AnswerDialog, type AnswerInput } from "./answer-dialog.js";
import { KIND_PRESENTATION, scopeLabel } from "./ask-kinds.js";
import { AskRow } from "./ask-row.js";

export interface InboxViewProps {
  asks: Ask[] | null;
  error?: string | null;
  onRetry?: () => void;
  answer: (input: AnswerInput) => Promise<unknown>;
}

function askKey(ask: Pick<Ask, "repository" | "id">): string {
  return `${ask.repository}:${ask.id}`;
}

function isKind(value: string): value is Kind {
  return (kinds as string[]).includes(value);
}

function searchValues(ask: Ask): string[] {
  return [
    ask.question,
    ask.task,
    ask.repository,
    KIND_PRESENTATION[ask.kind]?.label ?? ask.kind,
    ask.recommendation,
    ...(ask.options ?? []),
  ];
}

export function InboxView({ asks, error = null, onRetry, answer }: InboxViewProps) {
  const [query, setQuery] = useState("");
  const [kindFilters, setKindFilters] = useState<Kind[]>([]);
  const [taskFilters, setTaskFilters] = useState<string[]>([]);
  const [repositoryFilters, setRepositoryFilters] = useState<string[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const open = useMemo(() => filterAsks(asks ?? []), [asks]);
  const kindCounts = useMemo(() => {
    const counts = new Map<Kind, number>();
    for (const ask of open) counts.set(ask.kind, (counts.get(ask.kind) ?? 0) + 1);
    return counts;
  }, [open]);
  const taskOptions = useMemo(
    () =>
      [...new Set(open.map((ask) => ask.task))]
        .sort()
        .map((task) => ({ id: task, label: task || "No task" })),
    [open],
  );
  const repositoryOptions = useMemo(
    () =>
      [...new Set(open.map((ask) => ask.repository))]
        .sort()
        .map((repository) => ({ id: repository, label: repository })),
    [open],
  );
  const normalizedQuery = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      open.filter(
        (ask) =>
          (kindFilters.length === 0 || kindFilters.includes(ask.kind)) &&
          (taskFilters.length === 0 || taskFilters.includes(ask.task)) &&
          (repositoryFilters.length === 0 ||
            repositoryFilters.includes(ask.repository)) &&
          (normalizedQuery.length === 0 ||
            searchValues(ask).some((value) =>
              value.toLowerCase().includes(normalizedQuery),
            )),
      ),
    [open, kindFilters, taskFilters, repositoryFilters, normalizedQuery],
  );
  const selected =
    selectedKey === null
      ? null
      : (open.find((ask) => askKey(ask) === selectedKey) ?? null);
  const hasFilters =
    kindFilters.length > 0 ||
    taskFilters.length > 0 ||
    repositoryFilters.length > 0;

  let body: ReactNode;
  if (asks === null && error !== null) {
    body = (
      <ResourceListState
        state="error"
        message="Inbox could not be loaded."
        onRetry={onRetry}
      />
    );
  } else if (asks === null) {
    body = (
      <DelayedLoading>
        <ResourceListState state="loading" message="Loading asks" />
      </DelayedLoading>
    );
  } else if (open.length === 0) {
    body = (
      <ResourceListState
        state="empty"
        message="No open asks. Agents raise one here when they need a secret, a value, a permission or a decision from you."
      />
    );
  } else if (visible.length === 0) {
    body = (
      <ResourceListState
        state="empty"
        message={
          normalizedQuery === ""
            ? "No asks match these filters."
            : hasFilters
              ? `No asks match "${query}" with these filters.`
              : `No asks match "${query}"`
        }
      />
    );
  } else {
    body = (
      <ResourceListPanel>
        {visible.map((ask) => (
          <AskRow
            key={askKey(ask)}
            ask={ask}
            now={now}
            onAnswer={(next) => setSelectedKey(askKey(next))}
          />
        ))}
      </ResourceListPanel>
    );
  }

  return (
    <>
      <ResourceCollectionPage
        id="hyperfide-asks-inbox"
        description="Asks raised by agents working in your repositories. Secrets, variables and permissions block the task until you answer; decisions and questions proceed on the recommendation."
      >
        <ResourceCollectionViewport
          scrollId="hyperfide-asks-inbox-results"
          contentClassName="space-y-3"
          toolbar={
            <ResourceToolbar
              searchValue={query}
              searchPlaceholder="Search asks"
              onSearchChange={setQuery}
              controls={
                <ResourceFilterMenu
                  compact
                  groups={[
                    {
                      id: "kind",
                      label: "Kind",
                      options: kinds.map((kind) => ({
                        id: kind,
                        label: KIND_PRESENTATION[kind].label,
                        description:
                          kindCounts.get(kind) !== undefined
                            ? `${kindCounts.get(kind)} open`
                            : undefined,
                      })),
                      selectedValues: kindFilters,
                      onChange: (values) => setKindFilters(values.filter(isKind)),
                    },
                    {
                      id: "task",
                      label: "Task",
                      options: taskOptions,
                      selectedValues: taskFilters,
                      onChange: setTaskFilters,
                    },
                    {
                      id: "repository",
                      label: "Repository",
                      options: repositoryOptions.length > 1 ? repositoryOptions : [],
                      selectedValues: repositoryFilters,
                      onChange: setRepositoryFilters,
                    },
                  ]}
                />
              }
            />
          }
        >
          {asks !== null && error !== null ? (
            <p
              role="alert"
              className="rounded-md border border-surface-destructive-border bg-surface-destructive px-2 py-1 text-xs text-destructive-text"
            >
              Inbox could not be refreshed. Showing the last loaded asks.
            </p>
          ) : null}
          {body}
        </ResourceCollectionViewport>
      </ResourceCollectionPage>
      {selected ? (
        <AnswerDialog
          key={askKey(selected)}
          ask={selected}
          now={now}
          answer={answer}
          onClose={() => setSelectedKey(null)}
        />
      ) : null}
    </>
  );
}

