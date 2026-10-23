import { useEffect, useState } from "react";
import { useRpc } from "@hyperfide/plugin-sdk/app";
import type { imageBuilderContract } from "./rpc.js";
import type { BuildRecord } from "./builder.js";
export function ImageBuilderView() {
  const rpc = useRpc<typeof imageBuilderContract>();
  const [commit, setCommit] = useState("");
  const [jobs, setJobs] = useState<BuildRecord[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void rpc.call("imageBuilds").then(
        (value) => {
          if (active) setJobs(value);
        },
        (reason) => {
          if (active) setError(String(reason));
        },
      );
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [rpc]);
  async function action(run: () => Promise<unknown>) {
    try {
      await run();
      setError("");
      setJobs(await rpc.call("imageBuilds"));
    } catch (reason) {
      setError(String(reason));
    }
  }
  return (
    <main className="p-6 space-y-6 text-foreground">
      <h1>Image builder</h1>
      <label>
        Repository commit{" "}
        <input value={commit} onChange={(e) => setCommit(e.target.value)} />
      </label>
      <button
        disabled={
          !/^[a-f0-9]{40}$/.test(commit) ||
          jobs.some((j) => j.status === "running")
        }
        onClick={() =>
          void action(() => rpc.call("imageBuildStart", { commit }))
        }
      >
        Build image
      </button>
      {error && <p role="alert">{error}</p>}
      {jobs.map((job) => (
        <section key={job.id} aria-label={`Build ${job.commit}`}>
          <h2>{job.commit}</h2>
          <p role="status">
            {job.status}:{" "}
            {job.steps.filter((s) => s.status === "succeeded").length} steps
            complete
          </p>
          <p>{job.checkpoint}</p>
          {job.error && <p role="alert">{job.error}</p>}
          <button
            disabled={job.status !== "running"}
            onClick={() =>
              void action(() => rpc.call("imageBuildCancel", { id: job.id }))
            }
          >
            Cancel build
          </button>
          <ol>
            {job.steps.map((step) => (
              <li key={step.name}>
                {step.name}: {step.status} ({step.ms}ms)<pre>{step.log}</pre>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </main>
  );
}
