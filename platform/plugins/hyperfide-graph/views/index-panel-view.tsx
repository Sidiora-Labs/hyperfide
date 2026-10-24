import { useId, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ResourceActivitySection,
  ResourceCollectionPage,
  ResourceCollectionViewport,
  ResourceDefinitionSection,
  ResourceDetailConfigurationSection,
  ResourceDetailOverviewSection,
  ResourceDetailStack,
  ResourceListState,
  ResourceStatus,
} from "@/components/ui/resource-list";
import { Switch } from "@/components/ui/switch";
import type { GraphResult } from "../contract.js";
import { IndexView } from "./index-summary.js";
import { SurveyViewer } from "./survey-viewer.js";

export type GraphPending = "index" | "survey" | "settings" | null;

export interface IndexPanelViewProps {
  hostId: string;
  repository: string;
  onHostChange: (value: string) => void;
  onRepositoryChange: (value: string) => void;
  languageServer: "running" | "stopped";
  pending: GraphPending;
  error: string;
  result: GraphResult | undefined;
  onRefreshIndex: () => void;
  target: string;
  onTargetChange: (value: string) => void;
  survey: GraphResult | undefined;
  surveyTarget: string;
  onSurvey: () => void;
  enabled: boolean;
  onEnabledChange: (value: boolean) => void;
  binaryPath: string;
  onBinaryPathChange: (value: string) => void;
  settingsSaved: boolean;
  onSaveSettings: () => void;
}

const ERROR_CLASS =
  "rounded-md border border-surface-destructive-border bg-surface-destructive px-2 py-1 text-xs text-destructive-text";

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        {hint ? (
          <p className="text-xs leading-snug text-muted-foreground">{hint}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function IndexPanelView({
  hostId,
  repository,
  onHostChange,
  onRepositoryChange,
  languageServer,
  pending,
  error,
  result,
  onRefreshIndex,
  target,
  onTargetChange,
  survey,
  surveyTarget,
  onSurvey,
  enabled,
  onEnabledChange,
  binaryPath,
  onBinaryPathChange,
  settingsSaved,
  onSaveSettings,
}: IndexPanelViewProps) {
  const formId = useId();
  const hostFieldId = `${formId}-host`;
  const repositoryFieldId = `${formId}-repository`;
  const targetFieldId = `${formId}-target`;
  const binaryFieldId = `${formId}-binary`;
  const enabledFieldId = `${formId}-enabled`;
  const scopeReady = hostId.trim() !== "" && repository.trim() !== "";
  const busy = pending !== null;

  return (
    <ResourceCollectionPage
      id="hyperfide-graph"
      description="Index freshness and surveys for a repository on one of your hosts. Queries run through the Hyperfide binary on that host and never leave it."
    >
      <ResourceCollectionViewport
        scrollId="hyperfide-graph-content"
        contentClassName="space-y-4"
      >
        {error ? (
          <p role="alert" className={ERROR_CLASS}>
            {error}
          </p>
        ) : null}
        <ResourceDetailStack>
          <ResourceDetailOverviewSection
            label="Scope"
            actions={
              <span role="status" aria-label="Language server status">
                <ResourceStatus
                  tone={
                    !scopeReady
                      ? "muted"
                      : languageServer === "running"
                        ? "success"
                        : "muted"
                  }
                >
                  Language server {scopeReady ? languageServer : "idle"}
                </ResourceStatus>
              </span>
            }
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id={hostFieldId} label="Host">
                <Input
                  id={hostFieldId}
                  value={hostId}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Host id"
                  onChange={(event) => onHostChange(event.target.value)}
                />
              </Field>
              <Field id={repositoryFieldId} label="Repository">
                <Input
                  id={repositoryFieldId}
                  value={repository}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="/path/to/repository"
                  className="font-mono"
                  onChange={(event) => onRepositoryChange(event.target.value)}
                />
              </Field>
            </div>
          </ResourceDetailOverviewSection>

          <ResourceDefinitionSection
            label="Index"
            actions={
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!scopeReady || busy}
                aria-busy={pending === "index"}
                onClick={onRefreshIndex}
              >
                <Icon
                  name={pending === "index" ? "Loading" : "RotateCcw"}
                  className={pending === "index" ? "animate-spin" : undefined}
                  aria-hidden
                />
                Refresh index
              </Button>
            }
          >
            {!scopeReady ? (
              <ResourceListState
                state="empty"
                message="Enter a host and a repository to read its index."
              />
            ) : pending === "index" && !result ? (
              <DelayedLoading>
                <ResourceListState
                  state="loading"
                  message="Loading index"
                  loadingRows={3}
                />
              </DelayedLoading>
            ) : result ? (
              <IndexView result={result} />
            ) : (
              <ResourceListState
                state="empty"
                message="Refresh to read the index status from the host."
              />
            )}
          </ResourceDefinitionSection>

          <ResourceActivitySection label="Survey">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1">
                <Field
                  id={targetFieldId}
                  label="Area"
                  hint="A directory, file or symbol to survey."
                >
                  <Input
                    id={targetFieldId}
                    value={target}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="src/server"
                    className="font-mono"
                    onChange={(event) => onTargetChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      if (scopeReady && !busy && target.trim() !== "")
                        onSurvey();
                    }}
                  />
                </Field>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="sm:mb-px"
                disabled={!scopeReady || busy || target.trim() === ""}
                aria-busy={pending === "survey"}
                onClick={onSurvey}
              >
                <Icon
                  name={pending === "survey" ? "Loading" : "Explore"}
                  className={pending === "survey" ? "animate-spin" : undefined}
                  aria-hidden
                />
                Survey
              </Button>
            </div>
            {survey ? (
              <SurveyViewer
                data={survey.data}
                binary={survey.binary}
                target={surveyTarget}
              />
            ) : pending === "survey" ? (
              <DelayedLoading>
                <ResourceListState
                  state="loading"
                  message="Running survey"
                  loadingRows={2}
                />
              </DelayedLoading>
            ) : null}
          </ResourceActivitySection>

          <ResourceDetailConfigurationSection
            label="Settings"
            actions={
              <div className="flex items-center gap-2">
                {settingsSaved ? (
                  <ResourceStatus tone="success">Saved</ResourceStatus>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!scopeReady || busy}
                  aria-busy={pending === "settings"}
                  onClick={onSaveSettings}
                >
                  {pending === "settings" ? (
                    <Icon name="Loading" className="animate-spin" aria-hidden />
                  ) : null}
                  Save settings
                </Button>
              </div>
            }
          >
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-0.5">
                  <Label htmlFor={enabledFieldId}>Enable for repository</Label>
                  <p className="text-xs leading-snug text-muted-foreground">
                    Let agents and the Index panel run graph queries against
                    this repository.
                  </p>
                </div>
                <Switch
                  id={enabledFieldId}
                  checked={enabled}
                  disabled={!scopeReady || busy}
                  onCheckedChange={onEnabledChange}
                  className="mt-0.5"
                />
              </div>
              <Field
                id={binaryFieldId}
                label="Binary path override"
                hint="Leave empty to resolve the binary from HYPERFIDE_BIN, the repository's cg or PATH on the host."
              >
                <Input
                  id={binaryFieldId}
                  value={binaryPath}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!scopeReady || busy}
                  placeholder="/usr/local/bin/cg"
                  className="font-mono"
                  onChange={(event) => onBinaryPathChange(event.target.value)}
                />
              </Field>
            </div>
          </ResourceDetailConfigurationSection>
        </ResourceDetailStack>
      </ResourceCollectionViewport>
    </ResourceCollectionPage>
  );
}
