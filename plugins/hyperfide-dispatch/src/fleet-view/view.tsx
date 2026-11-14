import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import {
  ResourceDetailPanel,
  ResourceCollectionPage,
  ResourceCollectionViewport,
  ResourceToolbar,
  ResourceListPanel,
  ResourceStatus,
  ResourceFilterMenu,
} from "@/components/ui/resource-list";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@hyperfide/plugin-sdk/app";
import {
  stages,
  type fleetRpcContract,
  type FleetLedger,
  type FleetAction,
  FLEET_CHANGED_CHANNEL,
} from "./contract.js";

type DataFreshness = "fresh" | "stale" | "unknown";

function elapsed(start: string | null, end: string | null, now: number) {
  return start === null
    ? "Pending"
    : `${Math.max(0, Math.floor(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000))}s`;
}

export function FleetView() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [states, setStates] = useState<string[]>([]);
  const rpc = useRpc<typeof fleetRpcContract>();
  const [ledger, setLedger] = useState<FleetLedger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cap, setCap] = useState("");
  const [now, setNow] = useState(Date.now());
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
  const [dataFreshness, setDataFreshness] = useState<DataFreshness>("unknown");
  const connectionState = useRealtimeConnectionState();
  const active = useRef(false);
  const mutating = useRef(false);
  const revision = useRef(0);
  const ledgerRef = useRef<FleetLedger | null>(null);
  const refreshQueued = useRef(false);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  ledgerRef.current = ledger;
  const refresh = useCallback(() => {
    refreshQueued.current = true;
    if (!active.current || mutating.current || refreshInFlight.current) return;
    const run = async () => {
      while (active.current && refreshQueued.current && !mutating.current) {
        refreshQueued.current = false;
        const request = ++revision.current;
        try {
          const value = await rpc.call("fleetLedger");
          if (active.current && request === revision.current) {
            ledgerRef.current = value;
            setLedger(value);
            setError(null);
            setDataFreshness("fresh");
            const refreshedAt = Date.now();
            setNow(refreshedAt);
            setLastRefreshAt(refreshedAt);
          }
        } catch (reason) {
          if (active.current && request === revision.current) {
            setError(String(reason));
            setDataFreshness(ledgerRef.current === null ? "unknown" : "stale");
          }
        }
      }
    };
    const request = run();
    refreshInFlight.current = request;
    const settle = () => {
      if (refreshInFlight.current === request) refreshInFlight.current = null;
      if (active.current && refreshQueued.current && !mutating.current)
        refresh();
    };
    void request.then(settle, settle);
  }, [rpc]);
  useRealtime(FLEET_CHANGED_CHANNEL, refresh);
  useEffect(() => {
    if (connectionState === "connected") refresh();
  }, [connectionState, refresh]);
  useEffect(() => {
    active.current = true;
    refresh();
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") refresh();
    }, 5000);
    return () => {
      active.current = false;
      ++revision.current;
      refreshQueued.current = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearInterval(timer);
    };
  }, [refresh]);
  async function action(input: FleetAction) {
    if (mutating.current) return;
    mutating.current = true;
    ++revision.current;
    setBusy(true);
    setError(null);
    try {
      const value = await rpc.call("fleetAction", input);
      if (active.current) {
        ledgerRef.current = value;
        setLedger(value);
        setDataFreshness("fresh");
        const refreshedAt = Date.now();
        setNow(refreshedAt);
        setLastRefreshAt(refreshedAt);
      }
    } catch (reason) {
      if (active.current) setError(String(reason));
    } finally {
      mutating.current = false;
      if (active.current) setBusy(false);
      if (active.current && refreshQueued.current) refresh();
    }
  }
  const selected =
    ledger?.jobs.find((job) => job.id === selectedId) ?? ledger?.jobs[0];
  const canLegacyMutate =
    ledger?.authority.capabilities.includes("legacy-mutate") ?? false;
  const uncertainAuthority = ledger
    ? ["UNKNOWN", "OUTCOME_UNKNOWN"].includes(
        ledger.authority.state.toUpperCase(),
      )
    : false;
  const uncertainHistory =
    ledger?.history.some((row) =>
      ["UNKNOWN", "OUTCOME_UNKNOWN"].includes(
        row.receiptState?.toUpperCase() ?? "",
      ),
    ) ?? false;
  const matches = (item: { state: string }) =>
    (states.length === 0 || states.includes(item.state)) &&
    JSON.stringify(item).toLowerCase().includes(query.toLowerCase());
  return (
    <ResourceCollectionPage
      id="hyperfide-dispatch-fleet"
      description="Machines, job history and dispatch budgets."
    >
      <ResourceCollectionViewport
        scrollId="hyperfide-fleet-results"
        contentClassName="space-y-6"
        toolbar={
          <ResourceToolbar
            searchValue={query}
            onSearchChange={setQuery}
            searchPlaceholder="Search machines and jobs"
            controls={
              <ResourceFilterMenu
                groups={[
                  {
                    id: "state",
                    label: "State",
                    options: [
                      ...new Set(
                        [
                          ...(ledger?.machines ?? []),
                          ...(ledger?.jobs ?? []),
                        ].map((item) => item.state),
                      ),
                    ].map((id) => ({ id, label: id })),
                    selectedValues: states,
                    onChange: setStates,
                  },
                ]}
              />
            }
          />
        }
      >
        <h1 className="text-xl font-semibold">Fleet</h1>
        <p
          role="status"
          aria-label="Fleet freshness"
          className="text-sm text-muted-foreground"
        >
          Realtime: {connectionState}. Data: {dataFreshness.toUpperCase()}.{" "}
          {dataFreshness === "stale"
            ? "The last ledger read failed; displayed data may be stale."
            : dataFreshness === "unknown"
              ? "Causal freshness is UNKNOWN until an authoritative ledger read succeeds."
              : connectionState === "connected"
                ? lastRefreshAt === null
                  ? "Causal freshness is pending the first ledger read."
                  : `Causal freshness as of ${new Date(lastRefreshAt).toISOString()}.`
                : "Causal freshness is unknown until the connection recovers."}
        </p>
        {error && (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-destructive"
          >
            {error}
          </p>
        )}
        {!ledger ? (
          <DelayedLoading>
            <p role="status">Loading fleet...</p>
          </DelayedLoading>
        ) : (
          <>
            <section
              aria-label="Authority"
              className="rounded-md border border-border p-4 space-y-2"
            >
              <h2 className="font-semibold">Authority</h2>
              <p>
                Mode: {ledger.authority.mode} | State: {ledger.authority.state}
              </p>
              <p>
                Role: {ledger.authority.actorRole ?? "Unknown"} | Capabilities:{" "}
                {ledger.authority.capabilities.join(", ")}
              </p>
              <p className="text-sm text-muted-foreground">
                Authority epoch: {ledger.authority.authorityEpoch ?? "UNKNOWN"}{" "}
                | Leader generation:{" "}
                {ledger.authority.leaderGeneration ?? "UNKNOWN"} | Manager
                generation: {ledger.authority.managerGeneration ?? "UNKNOWN"} |
                Delegation: {ledger.authority.delegationId ?? "UNKNOWN"} | As
                of: {ledger.authority.asOf}
              </p>
              {uncertainAuthority && (
                <p
                  role="alert"
                  aria-label="Fleet authority warning"
                  className="text-sm text-destructive"
                >
                  Authority state {ledger.authority.state} is UNKNOWN; reconcile
                  the current authority before treating this view as committed
                  state.
                </p>
              )}
              {uncertainHistory && (
                <p
                  role="alert"
                  aria-label="Fleet outcome warning"
                  className="text-sm text-destructive"
                >
                  One or more authoritative operations have UNKNOWN or
                  OUTCOME_UNKNOWN receipts; reconcile the original operation
                  before retrying it.
                </p>
              )}
              {ledger.authority.mode === "manager" && (
                <p role="status" className="text-sm text-muted-foreground">
                  Manager-directed dispatch is read-only here. Submit an
                  admitted manager decision through the authenticated authority
                  route.
                </p>
              )}
            </section>
            <section
              aria-label="Budget"
              className="rounded-md border border-border p-4 space-y-3"
            >
              <h2 className="font-semibold">Budget</h2>
              {ledger.budget.status && (
                <p className="text-sm text-muted-foreground">
                  {ledger.budget.status}
                </p>
              )}
              <p>
                Cap: {ledger.budget.cap} / {ledger.budget.maximum} | In flight:{" "}
                {ledger.budget.inFlight} | Keys: {ledger.budget.keys} | Backoff
                until: {ledger.budget.backoffUntil ?? "None"}
              </p>
              <p>Dispatch {ledger.budget.paused ? "paused" : "active"}</p>
              {canLegacyMutate ? (
                <fieldset disabled={busy} className="flex flex-wrap gap-3">
                  <Button
                    onClick={() =>
                      void action({
                        kind: ledger.budget.paused ? "resume" : "pause",
                      })
                    }
                  >
                    {ledger.budget.paused
                      ? "Resume dispatch"
                      : "Pause dispatch"}
                  </Button>
                  <label>
                    Cap{" "}
                    <Input
                      aria-label="Cap"
                      type="number"
                      min={ledger.budget.cap}
                      max={ledger.budget.maximum}
                      step="1"
                      value={cap}
                      onChange={(event) => setCap(event.target.value)}
                    />
                  </label>
                  <Button
                    disabled={
                      cap.trim() === "" ||
                      !Number.isSafeInteger(Number(cap)) ||
                      Number(cap) <= ledger.budget.cap ||
                      ledger.budget.cap >= ledger.budget.maximum
                    }
                    onClick={() =>
                      void action({ kind: "raiseCap", cap: Number(cap) })
                    }
                  >
                    Raise cap
                  </Button>
                  <Button onClick={refresh}>Refresh</Button>
                </fieldset>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Budget controls are unavailable without the legacy mutation
                  capability.
                </p>
              )}
            </section>
            <section aria-label="Machines" className="overflow-x-auto">
              <h2 className="font-semibold mb-3">Machines</h2>
              <ResourceListPanel>
                {ledger.machines.filter(matches).length === 0 ? (
                  <p>No machines</p>
                ) : (
                  <table className="w-full text-left text-sm [&_td]:p-3 [&_th]:p-3 [&_tr]:border-b [&_tr]:border-border">
                    <thead>
                      <tr>
                        {[
                          "Machine",
                          "Provider",
                          "State",
                          "Job",
                          "Age",
                          ...(canLegacyMutate ? ["Action"] : []),
                        ].map((label) => (
                          <th key={label}>{label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {ledger.machines.filter(matches).map((machine) => (
                        <tr key={machine.id}>
                          <td>{machine.id}</td>
                          <td>{machine.provider}</td>
                          <td>
                            <ResourceStatus tone="muted">
                              {machine.state}
                            </ResourceStatus>
                          </td>
                          <td>{machine.job ?? "None"}</td>
                          <td>{elapsed(machine.createdAt, null, now)}</td>
                          {canLegacyMutate && (
                            <td>
                              <Button
                                disabled={busy}
                                onClick={() =>
                                  void action({
                                    kind: "destroy",
                                    id: machine.id,
                                  })
                                }
                              >
                                Destroy {machine.id}
                              </Button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </ResourceListPanel>
            </section>
            <section aria-label="Jobs" className="overflow-x-auto">
              <h2 className="font-semibold mb-3">Jobs</h2>
              <ResourceListPanel>
                {ledger.jobs.filter(matches).length === 0 ? (
                  <p>No jobs</p>
                ) : (
                  <table className="w-full text-left text-sm [&_td]:p-3 [&_th]:p-3 [&_tr]:border-b [&_tr]:border-border">
                    <thead>
                      <tr>
                        {[
                          "Job",
                          "Task",
                          "State",
                          "Attempt",
                          "Worker",
                          "Started",
                          "Duration",
                          "Log tail",
                          ...(canLegacyMutate ? ["Action"] : []),
                        ].map((label) => (
                          <th key={label}>{label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {ledger.jobs.filter(matches).map((job) => (
                        <tr key={job.id}>
                          <td>
                            <Button
                              variant="ghost"
                              onClick={() => setSelectedId(job.id)}
                            >
                              {job.id}
                            </Button>
                          </td>
                          <td>
                            {job.task}
                            {job.source && (
                              <small className="block text-muted-foreground">
                                {job.source}
                              </small>
                            )}
                          </td>
                          <td>
                            <ResourceStatus
                              tone={
                                job.state === "failed"
                                  ? "error"
                                  : job.state === "succeeded"
                                    ? "success"
                                    : job.state === "unknown" ||
                                        job.state === "reconciling"
                                      ? "warning"
                                      : "muted"
                              }
                            >
                              {job.state}
                            </ResourceStatus>
                            {job.reconciliation && (
                              <small className="block text-muted-foreground">
                                {job.reconciliation}
                              </small>
                            )}
                          </td>
                          <td>{job.attempt}</td>
                          <td>{job.worker ?? "Unassigned"}</td>
                          <td>{job.started ?? "Pending"}</td>
                          <td>{elapsed(job.started, job.finished, now)}</td>
                          <td>
                            <Button
                              variant="ghost"
                              onClick={() => setSelectedId(job.id)}
                            >
                              View log
                            </Button>
                          </td>
                          {canLegacyMutate && (
                            <td>
                              <Button
                                disabled={
                                  busy ||
                                  job.finished !== null ||
                                  job.state === "succeeded" ||
                                  job.state === "failed" ||
                                  job.state === "unknown" ||
                                  job.state === "reconciling"
                                }
                                onClick={() =>
                                  void action({ kind: "cancel", id: job.id })
                                }
                              >
                                Cancel {job.id}
                              </Button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </ResourceListPanel>
            </section>
            {selected && (
              <ResourceDetailPanel className="p-4 space-y-3">
                <h2 className="font-semibold">Job {selected.id}</h2>
                <p className="text-sm text-muted-foreground">
                  {selected.task} | {selected.source ?? "dispatcher"}
                </p>
                <pre
                  aria-label={`Log ${selected.id}`}
                  className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs"
                >
                  {selected.log || "No logs"}
                </pre>
              </ResourceDetailPanel>
            )}
            <section
              aria-label="Authoritative history"
              className="overflow-x-auto"
            >
              <h2 className="font-semibold mb-3">Authoritative history</h2>
              {ledger.history.length === 0 ? (
                <p>No control-plane receipts</p>
              ) : (
                <table className="w-full text-left text-sm [&_td]:p-3 [&_th]:p-3 [&_tr]:border-b [&_tr]:border-border">
                  <thead>
                    <tr>
                      {[
                        "Action",
                        "Actor",
                        "Delegation",
                        "Generations",
                        "Receipt",
                        "Created",
                      ].map((label) => (
                        <th key={label}>{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.history.map((row) => (
                      <tr key={row.operationId}>
                        <td>
                          {row.action}
                          <small className="block text-muted-foreground">
                            {row.decisionId}
                          </small>
                        </td>
                        <td>
                          {row.actorRole}: {row.actorId}
                        </td>
                        <td>{row.delegationId ?? "Primary"}</td>
                        <td>
                          {row.authorityEpoch ?? "?"}/
                          {row.leaderGeneration ?? "?"}/
                          {row.managerGeneration ?? "?"}
                        </td>
                        <td>
                          <ResourceStatus
                            tone={
                              ["UNKNOWN", "OUTCOME_UNKNOWN"].includes(
                                row.receiptState?.toUpperCase() ?? "",
                              )
                                ? "warning"
                                : row.receiptState?.toUpperCase() ===
                                    "SUCCEEDED"
                                  ? "success"
                                  : "muted"
                            }
                          >
                            {row.receiptState ?? "PENDING"}
                          </ResourceStatus>
                          {row.receiptDigest && (
                            <small className="block text-muted-foreground">
                              {row.receiptDigest}
                            </small>
                          )}
                        </td>
                        <td>{row.createdAt}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
            <section aria-label="Task timelines">
              <h2>Task timelines</h2>
              {ledger.timelines.length === 0 && <p>No task events</p>}
              {ledger.timelines.map((timeline) => (
                <article key={timeline.task}>
                  <h3>{timeline.task}</h3>
                  <ol className="flex flex-wrap gap-4">
                    {stages.map((stage) => (
                      <li key={stage}>
                        {stage}:{" "}
                        {timeline.events
                          .filter((event) => event.stage === stage)
                          .map((event) => event.at)
                          .join(", ") || "Pending"}
                      </li>
                    ))}
                  </ol>
                </article>
              ))}
            </section>
          </>
        )}
      </ResourceCollectionViewport>
    </ResourceCollectionPage>
  );
}
