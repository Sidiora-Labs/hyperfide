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
import { useRpc } from "@hyperfide/plugin-sdk/app";
import {
  stages,
  type fleetRpcContract,
  type FleetLedger,
  type FleetAction,
} from "./contract.js";

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
  const active = useRef(false);
  const mutating = useRef(false);
  const revision = useRef(0);
  const refresh = useCallback(() => {
    if (mutating.current) return;
    const request = ++revision.current;
    void rpc.call("fleetLedger").then(
      (value) => {
        if (active.current && request === revision.current) {
          setLedger(value);
          setError(null);
          setNow(Date.now());
        }
      },
      (reason) => {
        if (active.current && request === revision.current)
          setError(String(reason));
      },
    );
  }, [rpc]);
  useEffect(() => {
    active.current = true;
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      active.current = false;
      ++revision.current;
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
        setLedger(value);
        setNow(Date.now());
      }
    } catch (reason) {
      if (active.current) setError(String(reason));
    } finally {
      mutating.current = false;
      if (active.current) setBusy(false);
    }
  }
  const selected =
    ledger?.jobs.find((job) => job.id === selectedId) ?? ledger?.jobs[0];
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
              <fieldset disabled={busy} className="flex flex-wrap gap-3">
                <Button
                  onClick={() =>
                    void action({
                      kind: ledger.budget.paused ? "resume" : "pause",
                    })
                  }
                >
                  {ledger.budget.paused ? "Resume dispatch" : "Pause dispatch"}
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
                          "Action",
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
                          <td>
                            <Button
                              disabled={busy}
                              onClick={() =>
                                void action({ kind: "destroy", id: machine.id })
                              }
                            >
                              Destroy {machine.id}
                            </Button>
                          </td>
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
                          "Action",
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
                                    : "muted"
                              }
                            >
                              {job.state}
                            </ResourceStatus>
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
                          <td>
                            <Button
                              disabled={busy || job.finished !== null}
                              onClick={() =>
                                void action({ kind: "cancel", id: job.id })
                              }
                            >
                              Cancel {job.id}
                            </Button>
                          </td>
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
