import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useRpc,
  type PluginNavPanelProps,
} from "@hyperfide/plugin-sdk/app";
import {
  sourceContract,
  requestSchema,
  type SourceActionInput,
  type SourceProductRequest,
  type SourceProductResponse,
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
    [metrics, setMetrics] = useState<unknown>();
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
      try {
        const response = await rpc.call("execute", request);
        setReceipt(response);
        if (!response.ok) {
          setError(`${response.error.code}: ${response.error.message}`);
          if (
            response.error.outcome === "UNKNOWN" ||
            response.error.retry === "RETRY_SAME_OPERATION"
          )
            save(request);
          else save(null);
        } else {
          save(null);
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
        save(request);
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
    [rpc, save],
  );
  const run = useCallback(
    async (action: SourceActionInput): Promise<SourceProductResponse> => {
      if (activeRequest.current)
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
                      void rpc
                        .call("metrics", { projectId })
                        .then(setMetrics)
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
