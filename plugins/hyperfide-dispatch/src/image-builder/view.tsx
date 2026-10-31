import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import {
  ResourceCollectionPage,
  ResourceCollectionViewport,
  ResourceToolbar,
  ResourceListPanel,
  ResourceStatus,
} from "@/components/ui/resource-list";
import { useEffect, useState } from "react";
import { useRpc } from "@hyperfide/plugin-sdk/app";
import type { imageBuilderContract } from "./rpc.js";
import type { BuildRecord } from "./builder.js";
export function ImageBuilderView() {
  const [query, setQuery] = useState("");
  const [configuration, setConfiguration] = useState<{
    configured: boolean;
    message: string;
  } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const rpc = useRpc<typeof imageBuilderContract>();
  const [commit, setCommit] = useState("");
  const [jobs, setJobs] = useState<BuildRecord[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void rpc.call("imageBuilds").then(
        (value) => {
          if (active) {
            setJobs(value);
            setLoaded(true);
          }
        },
        (reason) => {
          if (active) setError(String(reason));
        },
      );
    void rpc.call("imageBuildConfiguration").then(
      (value) => {
        if (active) setConfiguration(value);
      },
      (reason) => {
        if (active) setError(String(reason));
      },
    );
    refresh();
    const timer = setInterval(refresh, 5000);
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
    <ResourceCollectionPage
      id="hyperfide-image-builder"
      description="Build a repository revision into a reusable machine checkpoint."
    >
      <ResourceCollectionViewport
        scrollId="hyperfide-image-results"
        contentClassName="space-y-6"
        toolbar={
          <ResourceToolbar
            searchValue={query}
            onSearchChange={setQuery}
            searchPlaceholder="Search image builds"
          />
        }
      >
        {!loaded && (
          <DelayedLoading>
            <p role="status">Loading image builds...</p>
          </DelayedLoading>
        )}
        {configuration && (
          <p role={configuration.configured ? "status" : "alert"}>
            {configuration.message}
          </p>
        )}
        <h1>Image builder</h1>
        <label>
          Repository commit{" "}
          <Input value={commit} onChange={(e) => setCommit(e.target.value)} />
        </label>
        <Button
          disabled={
            !commit.trim() ||
            configuration?.configured === false ||
            jobs.some((j) => j.status === "running")
          }
          onClick={() =>
            void action(() => rpc.call("imageBuildStart", { commit }))
          }
        >
          Build image
        </Button>
        {error && <p role="alert">{error}</p>}
        {loaded && jobs.length === 0 && <p>No image builds</p>}
        <ResourceListPanel>
          {jobs
            .filter((job) =>
              `${job.commit} ${job.status}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .map((job) => (
              <section
                className="space-y-3 border-b border-border p-4"
                key={job.id}
                aria-label={`Build ${job.commit}`}
              >
                <h2>{job.commit}</h2>
                <p role="status">
                  <ResourceStatus
                    tone={
                      job.status === "failed"
                        ? "error"
                        : job.status === "succeeded"
                          ? "success"
                          : "muted"
                    }
                  >
                    {job.status}
                  </ResourceStatus>
                  : {job.steps.filter((s) => s.status === "succeeded").length}{" "}
                  steps complete
                </p>
                <p>{job.checkpoint}</p>
                {job.error && <p role="alert">{job.error}</p>}
                <Button
                  disabled={job.status !== "running"}
                  onClick={() =>
                    void action(() =>
                      rpc.call("imageBuildCancel", { id: job.id }),
                    )
                  }
                >
                  Cancel build
                </Button>
                <ol>
                  {job.steps.map((step) => (
                    <li key={step.name}>
                      {step.name}: {step.status} ({step.ms}ms)
                      <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">
                        {step.log}
                      </pre>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
        </ResourceListPanel>
      </ResourceCollectionViewport>
    </ResourceCollectionPage>
  );
}
