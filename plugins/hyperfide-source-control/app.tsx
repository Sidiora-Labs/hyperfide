import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useRpc,
  type PluginNavPanelProps,
} from "@hyperfide/plugin-sdk/app";
import {
  sourceContract,
  requestSchema,
  sourceCheckpointReceiptMatches,
  sourceHostCheckpointMatches,
  type SourceActionInput,
  type SourceProductRequest,
  type SourceProductResponse,
  type SourceWorkspaceEvidence,
} from "./contract.js";
import { WorkspaceDetail } from "./views/workspace-detail.js";
import { ChangeDetail } from "./views/change-detail.js";
import { SourceMetricsView } from "./views/metrics.js";
import { TransferStatus } from "./views/transfer-status.js";
import { PublicationStatus } from "./views/publication-status.js";
import { Field, Receipt, buttonClass, inputClass } from "./views/shared.js";

const journalKey = "hyperfide.source.pending.v1";
const isRead = (action: SourceActionInput) =>
  [
    "readiness",
    "revision",
    "service-metrics",
    "history",
    "diff",
    "workspace",
    "file",
    "assignment",
    "candidate",
    "publication",
    "operation",
    "transformation",
    "transfer",
  ].includes(action.kind);
type Completion = {
  request: SourceProductRequest;
  response: SourceProductResponse;
};
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export function workspaceReceiptEvidence(
  request: SourceProductRequest,
  response: SourceProductResponse,
  previous: SourceWorkspaceEvidence[],
): SourceWorkspaceEvidence | null {
  if (!response.ok || response.operationId !== request.operationId) return null;
  const result = object(response.result);
  if (!result) return null;
  if (request.action.kind === "workspace") {
    const recovered = object(result.checkpointEvidence);
    const checkpoint = recovered?.checkpoint;
    if (
      recovered?.projectId === request.projectId &&
      sourceHostCheckpointMatches(checkpoint, result.workspace) &&
      checkpoint.workspaceId === request.action.workspaceId
    )
      return {
        projectId: request.projectId,
        workspaceGeneration: checkpoint.result.workspace.workspace_generation,
        scopeGeneration: checkpoint.scopeGeneration,
        workspaceId: checkpoint.workspaceId,
        revisionId: checkpoint.result.revision_id,
        stage: "ACKNOWLEDGED",
        operationId: checkpoint.operationId,
      };
    return null;
  }
  if (
    request.action.kind === "checkpoint" &&
    sourceCheckpointReceiptMatches(
      request.operationId,
      request.action,
      result,
    ) &&
    typeof result.revision_id === "string"
  )
    return {
      projectId: request.projectId,
      workspaceGeneration: String(
        BigInt(request.action.workspaceGeneration) + 1n,
      ),
      scopeGeneration: request.action.scopeGeneration,
      workspaceId: request.action.workspaceId,
      revisionId: result.revision_id,
      stage: "ACKNOWLEDGED",
      operationId: request.operationId,
    };
  if (
    request.action.kind === "submit" &&
    result.state === "SUBMITTED" &&
    typeof result.revision_id === "string" &&
    typeof result.submission_id === "string"
  ) {
    const prior = previous.find(
      (value) =>
        value.projectId === request.projectId &&
        value.revisionId === result.revision_id,
    );
    if (prior)
      return { ...prior, stage: "SUBMITTED", operationId: request.operationId };
  }
  const stage =
    request.action.kind === "accept" && typeof result.acceptance_id === "string"
      ? "ACCEPTED"
      : ["publication", "resume-publication", "publish"].includes(
            request.action.kind,
          ) &&
          result.status === "PUBLISHED" &&
          typeof result.git_oid === "string"
        ? "EXPORTED"
        : null;
  const prior = previous.find(
    (value) =>
      value.projectId === request.projectId &&
      value.revisionId === result.revision_id,
  );
  return stage && prior
    ? { ...prior, stage, operationId: request.operationId }
    : null;
}
function savedRequest(): SourceProductRequest | null {
  try {
    const raw = sessionStorage.getItem(journalKey);
    return raw ? requestSchema.parse(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
export function SourcePanel(_props: PluginNavPanelProps) {
  const rpc = useRpc<typeof sourceContract>();
  const [projects, setProjects] = useState<
      {
        id: string;
        name: string;
        configured: boolean;
        revisions: { id: string; label: string }[];
        assignments: { id: string; label: string }[];
      }[]
    >([]),
    [projectId, setProjectId] = useState("");
  const [tab, setTab] = useState<
      "workspace" | "changes" | "publication" | "transfers" | "metrics"
    >("workspace"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [sending, setSending] = useState(false),
    [receipt, setReceipt] = useState<unknown>(),
    [journal, setJournal] = useState<SourceProductRequest | null>(savedRequest),
    [metrics, setMetrics] = useState<unknown>(),
    [completion, setCompletion] = useState<Completion | null>(null),
    [workspaceEvidence, setWorkspaceEvidence] = useState<
      SourceWorkspaceEvidence[]
    >([]);
  const completed = useCallback(
    (request: SourceProductRequest, response: SourceProductResponse) => {
      setCompletion({ request, response });
      setWorkspaceEvidence((previous) => {
        const evidence = workspaceReceiptEvidence(request, response, previous);
        if (!evidence)
          return request.action.kind === "workspace"
            ? previous.filter(
                (value) =>
                  value.projectId !== request.projectId ||
                  value.workspaceId !==
                    (
                      request.action as Extract<
                        SourceActionInput,
                        { kind: "workspace" }
                      >
                    ).workspaceId,
              )
            : previous;
        const prior = previous.find(
          (value) =>
            value.projectId === evidence.projectId &&
            value.workspaceId === evidence.workspaceId,
        );
        const stages = ["ACKNOWLEDGED", "SUBMITTED", "ACCEPTED", "EXPORTED"];
        if (
          prior?.revisionId === evidence.revisionId &&
          stages.indexOf(prior.stage) > stages.indexOf(evidence.stage)
        )
          return previous;
        return [
          ...previous.filter(
            (value) =>
              value.projectId !== evidence.projectId ||
              value.workspaceId !== evidence.workspaceId,
          ),
          evidence,
        ].slice(-128);
      });
    },
    [],
  );
  useEffect(() => {
    let current = true;
    void rpc
      .call("projects", {})
      .then((rows) => {
        if (current) {
          setProjects(rows);
          setProjectId(
            (previous) =>
              previous ||
              journal?.projectId ||
              rows.find((row) => row.configured)?.id ||
              rows[0]?.id ||
              "",
          );
        }
      })
      .catch((cause) => {
        if (current)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      current = false;
    };
  }, [rpc]);
  const activeRequest = useRef<SourceProductRequest | null>(journal);
  const save = useCallback((value: SourceProductRequest | null) => {
    activeRequest.current = value;
    setJournal(value);
    if (value) sessionStorage.setItem(journalKey, JSON.stringify(value));
    else sessionStorage.removeItem(journalKey);
  }, []);
  const execute = useCallback(
    async (request: SourceProductRequest): Promise<SourceProductResponse> => {
      setSending(true);
      setError("");
      setNotice("");
      if (request.action.kind === "workspace") {
        const workspaceId = request.action.workspaceId;
        setWorkspaceEvidence((previous) =>
          previous.filter(
            (value) =>
              value.projectId !== request.projectId ||
              value.workspaceId !== workspaceId,
          ),
        );
      }
      try {
        const response = await rpc.call("execute", request);
        setReceipt(response);
        if (!response.ok) {
          setError(`${response.error.code}: ${response.error.message}`);
          if (
            !isRead(request.action) &&
            (response.error.outcome === "UNKNOWN" ||
              response.error.retry === "RETRY_SAME_OPERATION")
          )
            save(request);
          else if (!isRead(request.action)) save(null);
        } else {
          if (!isRead(request.action)) save(null);
          completed(request, response);
          const labels: Partial<Record<SourceActionInput["kind"], string>> = {
            open: "Workspace opened",
            checkpoint: "Checkpoint committed",
            submit: "Revision submitted",
            qualify: "Candidate qualified",
            accept: "Revision accepted",
            publish: "Publication created",
            merge: "Merge recorded",
            "resolve-conflict": "Conflict resolution recorded",
            "resume-publication": "Publication reconciled",
            "cancel-publication": "Publication cancelled",
            "cancel-operation": "Operation cancelled",
          };
          const status = (response.result as { status?: string } | null)
            ?.status;
          setNotice(
            (labels[request.action.kind] ?? "Source refreshed") +
              (status ? ": " + status : ""),
          );
        }
        return response;
      } catch (cause) {
        if (!isRead(request.action)) save(request);
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(
          "Response unavailable. Reconcile or retry the retained operation. " +
            message,
        );
        return {
          ok: false,
          operationId: request.operationId,
          error: {
            code: "OUTCOME_UNKNOWN",
            message,
            retry: "RETRY_SAME_OPERATION",
            outcome: "UNKNOWN",
          },
        };
      } finally {
        setSending(false);
      }
    },
    [rpc, save, completed],
  );
  const run = useCallback(
    async (action: SourceActionInput): Promise<SourceProductResponse> => {
      if (activeRequest.current && !isRead(action))
        return {
          ok: false,
          operationId: activeRequest.current.operationId,
          error: {
            code: "OPERATION_PENDING",
            message:
              "Resolve the current operation before starting another request.",
            retry: "NEVER",
            outcome: "KNOWN",
          },
        };
      const operationId = crypto.randomUUID(),
        parsed = requestSchema.safeParse({ projectId, operationId, action });
      if (!parsed.success) {
        const message = parsed.error.issues
          .map((issue) => issue.path.join(".") + ": " + issue.message)
          .join("; ");
        setError(message);
        return {
          ok: false,
          operationId,
          error: {
            code: "INVALID_REQUEST",
            message,
            retry: "NEVER",
            outcome: "KNOWN",
          },
        };
      }
      if (!isRead(action)) save(parsed.data);
      return execute(parsed.data);
    },
    [projectId, execute, save],
  );
  const project = projects.find((item) => item.id === projectId);
  const reconcile = async () => {
    if (!journal) return;
    setSending(true);
    try {
      const response = await rpc.call("execute", {
        projectId: journal.projectId,
        operationId: crypto.randomUUID(),
        action: { kind: "operation", operationId: journal.operationId },
      });
      setReceipt(response);
      const result = response.ok ? (response.result as any) : null;
      if (
        result &&
        ["SUCCEEDED", "COMMITTED", "CANCELLED", "FAILED"].includes(result.state)
      ) {
        if (["SUCCEEDED", "COMMITTED"].includes(result.state)) {
          if (
            journal.action.kind === "checkpoint" &&
            !sourceCheckpointReceiptMatches(
              journal.operationId,
              journal.action,
              result.result,
            )
          ) {
            setError(
              "Checkpoint outcome has no matching receipt. Retain and retry the same operation.",
            );
            return;
          }
          completed(journal, {
            ok: true,
            operationId: journal.operationId,
            result: result.result,
          });
        }
        save(null);
        setError("");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-4 px-4 py-4 md:px-5">
        <header>
          <h1 className="text-xl font-semibold">Source control</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Inspect native source, checkpoint edits, and follow acceptance and
            publication.
          </p>
        </header>
        <Field label="Project">
          <select
            className={inputClass}
            value={projectId}
            disabled={sending || journal !== null}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">Select a project</option>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.configured ? "" : " — connection required"}
              </option>
            ))}
          </select>
        </Field>
        {notice && (
          <p
            role="status"
            className="rounded-md border border-border p-3 text-sm"
          >
            {notice}
          </p>
        )}
        {error && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm break-words"
          >
            {error}
          </div>
        )}
        {journal && (
          <section className="space-y-2 rounded-md border border-border p-3">
            <p className="text-sm font-medium">
              {sending ? "Request in progress:" : "Unresolved"}{" "}
              {journal.action.kind} operation
            </p>
            <code className="block break-all text-xs">
              {journal.operationId}
            </code>
            <div className="flex flex-wrap gap-2">
              <button
                className={buttonClass}
                disabled={sending}
                onClick={() => void execute(journal)}
              >
                Retry same operation
              </button>
              <button
                className={buttonClass}
                disabled={sending}
                onClick={() => void reconcile()}
              >
                Read operation status
              </button>
            </div>
          </section>
        )}
        {project && !project.configured && (
          <p className="rounded-md border border-border p-3 text-sm">
            Add this project and its protected connection file in the Source
            control plugin settings.
          </p>
        )}
        {project?.configured && (
          <>
            <nav aria-label="Source views" className="flex flex-wrap gap-2">
              {(
                [
                  "workspace",
                  "changes",
                  "publication",
                  "transfers",
                  "metrics",
                ] as const
              ).map((value) => (
                <button
                  key={value}
                  className={buttonClass}
                  aria-current={tab === value ? "page" : undefined}
                  onClick={() => {
                    setTab(value);
                    if (value === "metrics")
                      void run({ kind: "service-metrics", maxRows: 50 })
                        .then((response) => {
                          if (response.ok)
                            setMetrics({
                              source: response.result,
                              requests: (
                                response.result as { product_requests: unknown }
                              ).product_requests,
                            });
                        })
                        .catch((cause) => setError(String(cause)));
                  }}
                >
                  {value[0]!.toUpperCase() + value.slice(1)}
                </button>
              ))}
            </nav>
            <main key={projectId}>
              {tab === "workspace" && (
                <WorkspaceDetail
                  run={run}
                  projectId={projectId}
                  pending={sending || journal !== null}
                  revisions={project.revisions}
                  assignments={project.assignments}
                  journal={journal?.projectId === projectId ? journal : null}
                  completion={
                    completion?.request.projectId === projectId
                      ? completion
                      : null
                  }
                  evidence={workspaceEvidence}
                  completed={completed}
                />
              )}{" "}
              {tab === "changes" && (
                <ChangeDetail
                  run={run}
                  pending={sending || journal !== null}
                  revisions={project.revisions}
                />
              )}{" "}
              {tab === "publication" && (
                <PublicationStatus
                  run={run}
                  pending={sending || journal !== null}
                />
              )}{" "}
              {tab === "transfers" && (
                <TransferStatus
                  run={run}
                  pending={sending || journal !== null}
                />
              )}
              {tab === "metrics" && <SourceMetricsView value={metrics} />}
            </main>
          </>
        )}
        <Receipt value={receipt} />
      </div>
    </div>
  );
}
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "hyperfide-source-control",
    title: "Source control",
    icon: "GitBranch",
    path: "source-control",
    component: SourcePanel,
  });
});
