import { useState, useEffect } from "react";
import { useRpc } from "@hyperfide/plugin-sdk/app";
import {
  sourceContract,
  sourceCheckpointReceiptMatches,
  sourceHostCheckpointMatches,
  type SourceProductRequest,
  type SourceProductResponse,
  type SourceWorkspaceEvidence,
  type SourceClosureReadiness,
} from "../contract.js";
import { SourceMetricsView } from "./metrics.js";
import {
  Field,
  Receipt,
  RevisionInput,
  buttonClass,
  inputClass,
  type RunSource,
} from "./shared.js";

type Workspace = {
  workspace_id: string;
  workspace_generation: string;
  scope_generation: string;
  base_revision_id: string;
  checkpoint_revision_id: string | null;
  mode: string;
  read_paths: string[];
  write_paths: string[];
  budgets: Record<string, number>;
};
export function WorkspaceDetail({
  run,
  pending: sourcePending,
  projectId,
  revisions,
  assignments,
  journal,
  completion,
  evidence,
  completed,
}: {
  run: RunSource;
  pending: boolean;
  projectId: string;
  revisions: { id: string; label: string }[];
  assignments: { id: string; label: string }[];
  journal: SourceProductRequest | null;
  completion: {
    request: SourceProductRequest;
    response: SourceProductResponse;
  } | null;
  evidence: SourceWorkspaceEvidence[];
  completed: (
    request: SourceProductRequest,
    response: SourceProductResponse,
  ) => void;
}) {
  const [revision, setRevision] = useState(revisions[0]?.id ?? ""),
    [paths, setPaths] = useState(""),
    [dependencyPaths, setDependencyPaths] = useState(""),
    [readiness, setReadiness] = useState<SourceClosureReadiness | null>(null),
    [mode, setMode] = useState<
      "API_ONLY" | "SPARSE" | "MATERIALIZED" | "VIRTUAL"
    >("API_ONLY");
  const retainedCheckpoint =
    journal?.action.kind === "checkpoint" ? journal.action : null;
  const [workspaceId, setWorkspaceId] = useState(
      retainedCheckpoint?.workspaceId ?? "",
    ),
    [workspace, setWorkspace] = useState<Workspace | null>(null),
    [path, setPath] = useState(retainedCheckpoint?.path ?? ""),
    [content, setContent] = useState(retainedCheckpoint?.content ?? ""),
    [dirty, setDirty] = useState(Boolean(retainedCheckpoint)),
    [executable, setExecutable] = useState(
      retainedCheckpoint?.executable ?? false,
    ),
    [receipt, setReceipt] = useState<unknown>();
  const rpc = useRpc<typeof sourceContract>();
  const [hostInfo, setHostInfo] = useState<{
      configured: boolean;
      hostName?: string;
      capabilities?: { available: boolean; reasons: string[] };
    } | null>(null),
    [hostError, setHostError] = useState(""),
    [hostBusy, setHostBusy] = useState(false),
    [hostUnresolved, setHostUnresolved] = useState(false),
    [attached, setAttached] = useState<{
      sliceId: string;
      path: string;
    } | null>(null),
    [hostMetrics, setHostMetrics] = useState<unknown>();
  const pending = sourcePending || hostBusy;
  const checkpointPending = retainedCheckpoint?.workspaceId === workspaceId;
  const durableEvidence = evidence.find(
    (value) =>
      value.projectId === projectId &&
      value.workspaceId === workspaceId &&
      workspace !== null &&
      value.revisionId === workspace.base_revision_id &&
      value.revisionId === workspace.checkpoint_revision_id &&
      value.workspaceGeneration === workspace.workspace_generation &&
      value.scopeGeneration === workspace.scope_generation,
  );
  const stage = checkpointPending
    ? "UPLOADING"
    : dirty
      ? "DIRTY"
      : (durableEvidence?.stage ?? "OPEN");
  const splitPaths = (value: string) =>
    value
      .split("\n")
      .map((path) => path.trim())
      .filter(Boolean);
  useEffect(() => {
    setReadiness(null);
  }, [revision, paths, dependencyPaths]);
  useEffect(() => {
    if (!completion?.response.ok) return;
    const action = completion.request.action;
    const value = completion.response.result as {
      workspace?: Workspace;
      readiness?: SourceClosureReadiness;
    } | null;
    if (
      (action.kind === "checkpoint" ||
        action.kind === "open" ||
        action.kind === "workspace") &&
      value?.workspace &&
      (!workspaceId ||
        value.workspace.workspace_id === workspaceId ||
        action.kind === "open")
    ) {
      setWorkspace(value.workspace);
      setWorkspaceId(value.workspace.workspace_id);
      if (value.readiness) setReadiness(value.readiness);
      if (
        action.kind === "checkpoint" &&
        sourceCheckpointReceiptMatches(
          completion.request.operationId,
          action,
          value,
        ) &&
        action.path === path &&
        action.content === content &&
        action.executable === executable
      )
        setDirty(false);
      setReceipt(value);
    }
  }, [completion]);
  useEffect(() => {
    if (!workspaceId || workspace) return;
    let current = true;
    void run({ kind: "workspace", workspaceId }).then((response) => {
      if (current && response.ok)
        setWorkspace((response.result as { workspace: Workspace }).workspace);
    });
    return () => {
      current = false;
    };
  }, [workspaceId, run]);
  useEffect(() => {
    let active = true;
    void rpc
      .call("hostCapabilities", { projectId })
      .then((value) => {
        if (active) setHostInfo(value);
      })
      .catch((error) => {
        if (active) setHostError(String(error));
      });
    return () => {
      active = false;
    };
  }, [rpc, projectId]);
  const hostAction = async (kind: "attach" | "checkpoint") => {
    if (!workspace) return;
    setHostBusy(true);
    setHostError("");
    try {
      if (kind === "attach") {
        if (workspace.mode === "API_ONLY")
          throw new Error(
            "Select a file-backed workspace mode before attaching a host",
          );
        setAttached(
          await rpc.call("attach", {
            projectId,
            workspaceId: workspace.workspace_id,
            mode: workspace.mode as "SPARSE" | "MATERIALIZED" | "VIRTUAL",
          }),
        );
      } else {
        setHostUnresolved(true);
        const acknowledgment = await rpc.call("checkpointHost", {
          projectId,
          workspaceId: workspace.workspace_id,
        });
        setReceipt(acknowledgment);
        const checkpoint = acknowledgment.checkpoint;
        if (
          checkpoint &&
          checkpoint.workspaceId === workspace.workspace_id &&
          sourceHostCheckpointMatches(checkpoint, checkpoint.result.workspace)
        ) {
          const operationId = crypto.randomUUID();
          completed(
            {
              projectId,
              operationId,
              action: {
                kind: "workspace",
                workspaceId: workspace.workspace_id,
              },
            },
            {
              ok: true,
              operationId,
              result: {
                workspace: checkpoint.result.workspace,
                checkpointEvidence: { projectId, checkpoint },
              },
            },
          );
        }
        setHostUnresolved(false);
        const result = await run({
          kind: "workspace",
          workspaceId: workspace.workspace_id,
        });
        if (result.ok)
          setWorkspace((result.result as { workspace: Workspace }).workspace);
      }
    } catch (error) {
      setHostError(
        "Host operation is unresolved or refused: " +
          String(error) +
          ". Retry the same workspace operation to reconcile.",
      );
    } finally {
      setHostBusy(false);
    }
  };
  const [assignmentId, setAssignmentId] = useState(""),
    [assignment, setAssignment] = useState<any>(null);
  const apply = async (action: Parameters<RunSource>[0]) => {
    const response = await run(action);
    if (response.ok) {
      const value = response.result as any;
      if (value?.workspace) {
        setWorkspace(value.workspace);
        setWorkspaceId(value.workspace.workspace_id);
      }
      if (value?.readiness) setReadiness(value.readiness);
      setReceipt(value);
    } else if (response.error.code === "DEPENDENCY_CLOSURE_INCOMPLETE") {
      setReadiness(response.error.details?.readiness as SourceClosureReadiness);
    }
    return response;
  };
  return (
    <div className="space-y-5">
      <section className="space-y-3 rounded-lg border border-border p-4">
        <h2 className="font-semibold">Open a workspace</h2>
        <p className="text-sm text-muted-foreground">
          Choose the immutable source and the paths this workspace may read and
          edit.
        </p>
        <RevisionInput
          value={revision}
          onChange={setRevision}
          revisions={revisions}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Paths (one per line)">
            <textarea
              className={inputClass}
              rows={3}
              value={paths}
              onChange={(event) => setPaths(event.target.value)}
              placeholder="core/example.ts"
            />
          </Field>
          <Field label="Required dependency paths (one per line)">
            <textarea
              className={inputClass}
              rows={3}
              value={dependencyPaths}
              onChange={(event) => setDependencyPaths(event.target.value)}
              placeholder="shared/dependency.ts"
            />
          </Field>
          <Field label="Workspace mode">
            <select
              className={inputClass}
              value={mode}
              onChange={(event) => setMode(event.target.value as typeof mode)}
            >
              <option value="API_ONLY">API only</option>
              <option value="SPARSE">Sparse files</option>
              <option value="MATERIALIZED">Materialized files</option>
              <option
                value="VIRTUAL"
                disabled={!hostInfo?.capabilities?.available}
              >
                Virtual files (supported host required)
              </option>
            </select>
          </Field>
        </div>
        <p
          role="status"
          data-source-closure={readiness?.state ?? "UNCHECKED"}
          className="text-sm"
        >
          Dependency closure:{" "}
          {readiness?.state === "READY"
            ? `Ready · ${readiness.checkedPaths} paths verified at the selected revision`
            : readiness?.state === "INCOMPLETE"
              ? "Incomplete · include missing dependencies in the read scope and revision"
              : "Not checked"}
        </p>
        {readiness?.state === "INCOMPLETE" && (
          <p className="break-all text-sm">
            Missing: {readiness.missingPaths.join(", ") || "none"}. Outside
            scope: {readiness.outsideScope.join(", ") || "none"}.
          </p>
        )}
        <button
          className={buttonClass}
          disabled={pending || !revision || !paths.trim()}
          onClick={() =>
            void run({
              kind: "readiness",
              revisionId: revision,
              readPaths: splitPaths(paths),
              dependencyPaths: splitPaths(dependencyPaths),
            }).then((result) => {
              if (result.ok)
                setReadiness(result.result as SourceClosureReadiness);
            })
          }
        >
          Check dependency closure
        </button>
        <button
          className={buttonClass}
          disabled={pending || !revision || !paths.trim()}
          onClick={() =>
            void apply({
              kind: "open",
              workspaceId: crypto.randomUUID(),
              revisionId: revision,
              readPaths: paths
                .split("\n")
                .map((item) => item.trim())
                .filter(Boolean),
              writePaths: paths
                .split("\n")
                .map((item) => item.trim())
                .filter(Boolean),
              mode,
              dependencyPaths: splitPaths(dependencyPaths),
            })
          }
        >
          Open workspace
        </button>
      </section>
      <section className="space-y-3 rounded-lg border border-border p-4">
        <h2 className="font-semibold">Workspace and checkpoint</h2>
        <Field label="Assigned workspace">
          <select
            className={inputClass}
            value={assignmentId}
            disabled={pending || dirty}
            onChange={(event) => {
              const id = event.target.value;
              setAssignmentId(id);
              setWorkspace(null);
              setWorkspaceId("");
              setDirty(false);
              setContent("");
              setPath("");
              if (id)
                void run({ kind: "assignment", assignmentId: id }).then(
                  async (result) => {
                    if (!result.ok) return;
                    const selected = result.result as { workspace_id: string };
                    setAssignment(selected);
                    await apply({
                      kind: "workspace",
                      workspaceId: selected.workspace_id,
                    });
                  },
                );
            }}
          >
            <option value="">Select an assigned workspace</option>
            {assignments.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>
        <p
          role="status"
          data-source-workspace-state={stage}
          className="text-sm"
        >
          State:{" "}
          {stage === "DIRTY"
            ? "Dirty · local edits await a checkpoint receipt"
            : stage === "UPLOADING"
              ? "Uploading · checkpoint outcome unresolved; no acknowledgment received"
              : stage === "ACKNOWLEDGED"
                ? "Acknowledged · checkpoint receipt received"
                : stage === "SUBMITTED"
                  ? "Submitted · server submission receipt received"
                  : stage === "ACCEPTED"
                    ? "Accepted · acceptance receipt received"
                    : stage === "EXPORTED"
                      ? "Exported · remote publication confirmed"
                      : "Open · no checkpoint receipt received"}
        </p>
        <Field label="Workspace">
          <input
            className={inputClass}
            value={workspaceId}
            disabled={pending || dirty}
            onChange={(event) => {
              setWorkspaceId(event.target.value);
              setWorkspace(null);
              setContent("");
              setDirty(false);
            }}
            placeholder="Workspace ID"
          />
        </Field>
        <button
          className={buttonClass}
          disabled={pending || !workspaceId}
          onClick={() => void apply({ kind: "workspace", workspaceId })}
        >
          Refresh workspace
        </button>
        {workspace && (
          <>
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <p>Generation: {workspace.workspace_generation}</p>
              <p>Mode: {workspace.mode}</p>
              <p className="break-all sm:col-span-2">
                Observed revision: {workspace.base_revision_id}
              </p>
              {durableEvidence && !checkpointPending && (
                <p className="break-all sm:col-span-2">
                  Receipt-backed revision: {durableEvidence.revisionId} ·{" "}
                  {durableEvidence.stage.toLowerCase()}
                </p>
              )}
              <p>
                Maximum file:{" "}
                {workspace.budgets.max_file_bytes.toLocaleString()} bytes
              </p>
            </div>
            <Field label="File path">
              <input
                className={inputClass}
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder={workspace.write_paths[0] ?? "path/to/file"}
              />
            </Field>
            <button
              className={buttonClass}
              disabled={pending || !path}
              onClick={() =>
                void run({
                  kind: "file",
                  revisionId: workspace.base_revision_id,
                  path,
                }).then((result) => {
                  if (result.ok) {
                    setContent((result.result as { content: string }).content);
                    setExecutable(
                      (result.result as { mode: string }).mode === "100755",
                    );
                    setDirty(false);
                  }
                })
              }
            >
              Load file from revision
            </button>
            <Field label="File content">
              <textarea
                className={inputClass + " font-mono"}
                rows={12}
                maxLength={65536}
                value={content}
                onChange={(event) => {
                  setContent(event.target.value);
                  setDirty(true);
                }}
                spellCheck={false}
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={executable}
                onChange={(event) => {
                  setExecutable(event.target.checked);
                  setDirty(true);
                }}
              />
              Executable file
            </label>
            <p className="text-xs text-muted-foreground">
              Edits become durable after the checkpoint receipt returns.
            </p>
            <button
              className={buttonClass}
              disabled={pending || !path || !dirty}
              onClick={() =>
                void apply({
                  kind: "checkpoint",
                  workspaceId: workspace.workspace_id,
                  baseRevisionId: workspace.base_revision_id,
                  workspaceGeneration: workspace.workspace_generation,
                  scopeGeneration: workspace.scope_generation,
                  overlayGeneration: workspace.workspace_generation,
                  path,
                  content,
                  executable,
                })
              }
            >
              Save durable checkpoint
            </button>
          </>
        )}
      </section>
      <section className="space-y-3 rounded-lg border border-border p-4">
        <h2 className="font-semibold">Files on an enrolled host</h2>
        {hostInfo?.configured ? (
          <>
            <p className="text-sm">Host: {hostInfo.hostName}</p>
            <p className="text-sm">
              Virtual filesystem:{" "}
              {hostInfo.capabilities?.available ? "Available" : "Unavailable"}
            </p>
            {!hostInfo.capabilities?.available && (
              <p className="text-sm">
                {hostInfo.capabilities?.reasons.join(", ")}. Select sparse or
                materialized mode explicitly.
              </p>
            )}
            <button
              className={buttonClass}
              disabled={pending || !workspace || workspace.mode === "API_ONLY"}
              onClick={() => void hostAction("attach")}
            >
              Attach workspace files
            </button>
            {attached && (
              <>
                <p className="break-all text-sm">Host path: {attached.path}</p>
                <button
                  className={buttonClass}
                  disabled={pending}
                  onClick={() => void hostAction("checkpoint")}
                >
                  Checkpoint host edits
                </button>
                <button
                  className={buttonClass}
                  disabled={pending}
                  onClick={() =>
                    void rpc
                      .call("hostMetrics", {
                        projectId,
                        workspaceId: workspace!.workspace_id,
                      })
                      .then(setHostMetrics)
                      .catch((error) => setHostError(String(error)))
                  }
                >
                  Inspect host metrics
                </button>
                <SourceMetricsView value={{ host: hostMetrics }} />
              </>
            )}
          </>
        ) : (
          <p className="text-sm">
            Configure a host and its source connection file in the project
            binding to attach workspace files.
          </p>
        )}
        {hostError && (
          <p role="alert" className="text-sm break-words">
            {hostError}
          </p>
        )}
      </section>
      <section className="space-y-3 rounded-lg border border-border p-4">
        <h2 className="font-semibold">Submit assigned work</h2>
        <Field label="Assignment">
          <input
            className={inputClass}
            value={assignmentId}
            list="native-source-assignments"
            onChange={(event) => setAssignmentId(event.target.value)}
          />
          <datalist id="native-source-assignments">
            {assignments.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </datalist>
        </Field>
        <button
          className={buttonClass}
          disabled={pending || !assignmentId}
          onClick={() =>
            void run({ kind: "assignment", assignmentId }).then((result) => {
              if (result.ok) {
                setAssignment(result.result);
                setReceipt(result.result);
              }
            })
          }
        >
          Inspect assignment
        </button>
        {assignment && workspace && (
          <button
            className={buttonClass}
            disabled={
              pending ||
              dirty ||
              checkpointPending ||
              hostUnresolved ||
              !durableEvidence ||
              assignment.workspace_id !== workspace.workspace_id
            }
            onClick={() =>
              void apply({
                kind: "submit",
                assignmentId,
                assignmentGeneration: assignment.assignment_generation,
                workspaceGeneration: workspace.workspace_generation,
                revisionId: workspace.base_revision_id,
              })
            }
          >
            Submit durable revision
          </button>
        )}
      </section>
      <Receipt value={receipt} />
    </div>
  );
}
