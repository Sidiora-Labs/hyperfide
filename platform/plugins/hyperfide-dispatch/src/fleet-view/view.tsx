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
  return (
    <main className="p-6 space-y-6 text-foreground">
      <h1 className="text-xl font-semibold">Fleet</h1>
      {error && <p role="alert">{error}</p>}
      {!ledger ? (
        <p role="status">Loading fleet...</p>
      ) : (
        <>
          <section
            aria-label="Budget"
            className="rounded-md border border-border p-4 space-y-3"
          >
            <h2>Budget</h2>
            <p>
              Cap: {ledger.budget.cap} / {ledger.budget.maximum} | In flight:{" "}
              {ledger.budget.inFlight} | Keys: {ledger.budget.keys} | Backoff
              until: {ledger.budget.backoffUntil ?? "None"}
            </p>
            <p>Dispatch {ledger.budget.paused ? "paused" : "active"}</p>
            <fieldset disabled={busy} className="flex flex-wrap gap-3">
              <button
                onClick={() =>
                  void action({
                    kind: ledger.budget.paused ? "resume" : "pause",
                  })
                }
              >
                {ledger.budget.paused ? "Resume dispatch" : "Pause dispatch"}
              </button>
              <label>
                Cap{" "}
                <input
                  aria-label="Cap"
                  type="number"
                  min={ledger.budget.cap}
                  max={ledger.budget.maximum}
                  step="1"
                  value={cap}
                  onChange={(event) => setCap(event.target.value)}
                />
              </label>
              <button
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
              </button>
              <button onClick={refresh}>Refresh</button>
            </fieldset>
          </section>
          <section aria-label="Machines" className="overflow-x-auto">
            <h2>Machines</h2>
            {ledger.machines.length === 0 ? (
              <p>No machines</p>
            ) : (
              <table className="w-full text-left">
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
                  {ledger.machines.map((machine) => (
                    <tr key={machine.id}>
                      <td>{machine.id}</td>
                      <td>{machine.provider}</td>
                      <td>{machine.state}</td>
                      <td>{machine.job ?? "None"}</td>
                      <td>{elapsed(machine.createdAt, null, now)}</td>
                      <td>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void action({ kind: "destroy", id: machine.id })
                          }
                        >
                          Destroy {machine.id}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section aria-label="Jobs" className="overflow-x-auto">
            <h2>Jobs</h2>
            {ledger.jobs.length === 0 ? (
              <p>No jobs</p>
            ) : (
              <table className="w-full text-left">
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
                  {ledger.jobs.map((job) => (
                    <tr key={job.id}>
                      <td>{job.id}</td>
                      <td>{job.task}</td>
                      <td>{job.state}</td>
                      <td>{job.attempt}</td>
                      <td>{job.worker ?? "Unassigned"}</td>
                      <td>{job.started ?? "Pending"}</td>
                      <td>{elapsed(job.started, job.finished, now)}</td>
                      <td>
                        <pre
                          aria-label={`Log ${job.id}`}
                          className="max-h-48 max-w-xl overflow-auto"
                        >
                          {job.log || "No logs"}
                        </pre>
                      </td>
                      <td>
                        <button
                          disabled={busy || job.finished !== null}
                          onClick={() =>
                            void action({ kind: "cancel", id: job.id })
                          }
                        >
                          Cancel {job.id}
                        </button>
                      </td>
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
    </main>
  );
}
