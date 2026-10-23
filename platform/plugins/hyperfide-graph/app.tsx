import { useEffect, useRef, useState } from "react";
import { definePluginApp, useRpc } from "@hyperfide/plugin-sdk/app";
import { graphRpcContract, type GraphResult } from "./contract.js";
export function IndexView({ result }: { result: GraphResult }) {
  const d = result.data;
  return (
    <section>
      <h2>Index</h2>
      <dl>
        <dt>Binary</dt>
        <dd>
          {result.binary.version} ({result.binary.digest.slice(0, 12)})
        </dd>
        <dt>Status</dt>
        <dd>{String(d.status ?? "unknown")}</dd>
        <dt>Last pass</dt>
        <dd>{String(d.last_pass ?? "unknown")}</dd>
        <dt>Symbols</dt>
        <dd>{String(d.symbols ?? d.symbol_count ?? "unknown")}</dd>
        <dt>Files</dt>
        <dd>{String(d.files ?? d.file_count ?? "unknown")}</dd>
        <dt>Stale anchors</dt>
        <dd>{String(d.stale_anchors ?? "unknown")}</dd>
      </dl>
    </section>
  );
}
export function SurveyViewer({ data }: { data: Record<string, unknown> }) {
  return (
    <section>
      <h2>Survey</h2>
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </section>
  );
}
export function IndexPanel() {
  const rpc = useRpc<typeof graphRpcContract>();
  const [hostId, setHost] = useState("");
  const [repository, setRepo] = useState("");
  const [target, setTarget] = useState("");
  const [result, setResult] = useState<GraphResult>();
  const [survey, setSurvey] = useState<GraphResult>();
  const [error, setError] = useState("");
  const [binaryPath, setBinary] = useState("");
  const [enabled, setEnabled] = useState(true);
  const currentScope = `${hostId}\0${repository}`;
  const scopeRef = useRef(currentScope);
  scopeRef.current = currentScope;
  useEffect(() => {
    let active = true;
    setResult(undefined);
    setSurvey(undefined);
    setError("");
    if (hostId && repository) {
      void rpc
        .call("getSettings", { hostId, repository })
        .then((settings) => {
          if (active) {
            setEnabled(settings.enabled);
            setBinary(settings.binaryPath ?? "");
          }
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    }
    return () => {
      active = false;
    };
  }, [rpc, hostId, repository]);
  async function load(command: "index-status" | "survey") {
    const requestedScope = currentScope;
    setError("");
    try {
      const value = await rpc.call("run", {
        hostId,
        repository,
        command,
        ...(command === "survey" ? { target } : {}),
      });
      if (scopeRef.current !== requestedScope) return;
      if (command === "survey") setSurvey(value);
      else setResult(value);
    } catch (e) {
      if (scopeRef.current === requestedScope) setError(String(e));
    }
  }
  return (
    <main>
      <h1>Index</h1>
      <label>
        Host
        <input value={hostId} onChange={(e) => setHost(e.target.value)} />
      </label>
      <label>
        Repository
        <input
          value={repository}
          onChange={(e) => {
            setRepo(e.target.value);
            setResult(undefined);
            setSurvey(undefined);
          }}
        />
      </label>
      <button onClick={() => void load("index-status")}>Refresh index</button>
      <label>
        Binary path override
        <input value={binaryPath} onChange={(e) => setBinary(e.target.value)} />
      </label>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Enable for repository
      </label>
      <button
        onClick={() => {
          void rpc
            .call("setSettings", {
              hostId,
              repository,
              settings: { enabled, ...(binaryPath ? { binaryPath } : {}) },
            })
            .catch((e) => setError(String(e)));
        }}
      >
        Save settings
      </button>
      {error && <p role="alert">{error}</p>}
      {result && <IndexView result={result} />}
      <label>
        Survey area
        <input value={target} onChange={(e) => setTarget(e.target.value)} />
      </label>
      <button onClick={() => void load("survey")}>Survey</button>
      {survey && <SurveyViewer data={survey.data} />}
    </main>
  );
}
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "hyperfide-graph",
    title: "Index",
    icon: "Network",
    path: "hyperfide-graph",
    component: IndexPanel,
  });
});
