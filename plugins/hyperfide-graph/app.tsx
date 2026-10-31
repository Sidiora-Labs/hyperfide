import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { definePluginApp, useRpc } from "@hyperfide/plugin-sdk/app";
import { graphRpcContract, type GraphResult } from "./contract.js";
import {
  IndexPanelView,
  type GraphPending,
} from "./views/index-panel-view.js";

export { IndexView } from "./views/index-summary.js";
export { SurveyViewer } from "./views/survey-viewer.js";

const LANGUAGE_SERVER_POLL_MS = 5000;
const SAVED_FEEDBACK_MS = 2500;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function PanelFrame({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border h-full min-h-full w-full max-w-5xl px-4 pb-4 pt-3 md:px-5 md:pt-4">
        {children}
      </div>
    </div>
  );
}

export function IndexPanel() {
  const rpc = useRpc<typeof graphRpcContract>();
  const [languageServer, setLanguageServer] = useState<"running" | "stopped">(
    "stopped",
  );
  const [hostId, setHost] = useState("");
  const [repository, setRepo] = useState("");
  const [target, setTarget] = useState("");
  const [surveyTarget, setSurveyTarget] = useState("");
  const [result, setResult] = useState<GraphResult>();
  const [survey, setSurvey] = useState<GraphResult>();
  const [error, setError] = useState("");
  const [binaryPath, setBinary] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [pending, setPending] = useState<GraphPending>(null);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const currentScope = `${hostId}\0${repository}`;
  const scopeRef = useRef(currentScope);

  useEffect(() => {
    scopeRef.current = currentScope;
  }, [currentScope]);

  const changeScope = useCallback(
    (next: { hostId?: string; repository?: string }) => {
      if (next.hostId !== undefined) setHost(next.hostId);
      if (next.repository !== undefined) setRepo(next.repository);
      setResult(undefined);
      setSurvey(undefined);
      setError("");
      setSettingsSaved(false);
      setLanguageServer("stopped");
    },
    [],
  );

  useEffect(() => {
    if (!hostId || !repository) return;
    let active = true;
    void rpc
      .call("getSettings", { hostId, repository })
      .then((settings) => {
        if (active) {
          setEnabled(settings.enabled);
          setBinary(settings.binaryPath ?? "");
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(errorText(cause));
      });
    return () => {
      active = false;
    };
  }, [rpc, hostId, repository]);

  useEffect(() => {
    if (!hostId || !repository) return;
    let active = true;
    const refresh = async () => {
      try {
        const status = await rpc.call("languageServerStatus", {
          hostId,
          repository,
        });
        if (active) setLanguageServer(status);
      } catch {
        if (active) setLanguageServer("stopped");
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), LANGUAGE_SERVER_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [rpc, hostId, repository]);

  useEffect(() => {
    if (!settingsSaved) return;
    const timer = setTimeout(() => setSettingsSaved(false), SAVED_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [settingsSaved]);

  const load = useCallback(
    async (command: "index-status" | "survey") => {
      const requestedScope = `${hostId}\0${repository}`;
      setError("");
      setPending(command === "survey" ? "survey" : "index");
      try {
        const value = await rpc.call("run", {
          hostId,
          repository,
          command,
          ...(command === "survey" ? { target } : {}),
        });
        if (scopeRef.current !== requestedScope) return;
        if (command === "survey") {
          setSurvey(value);
          setSurveyTarget(target);
        } else {
          setResult(value);
        }
      } catch (cause: unknown) {
        if (scopeRef.current === requestedScope) setError(errorText(cause));
      } finally {
        setPending(null);
      }
    },
    [rpc, hostId, repository, target],
  );

  const saveSettings = useCallback(async () => {
    setError("");
    setSettingsSaved(false);
    setPending("settings");
    try {
      const saved = await rpc.call("setSettings", {
        hostId,
        repository,
        settings: { enabled, ...(binaryPath ? { binaryPath } : {}) },
      });
      setEnabled(saved.enabled);
      setBinary(saved.binaryPath ?? "");
      setSettingsSaved(true);
    } catch (cause: unknown) {
      setError(errorText(cause));
    } finally {
      setPending(null);
    }
  }, [rpc, hostId, repository, enabled, binaryPath]);

  return (
    <PanelFrame>
      <IndexPanelView
        hostId={hostId}
        repository={repository}
        onHostChange={(value) => changeScope({ hostId: value })}
        onRepositoryChange={(value) => changeScope({ repository: value })}
        languageServer={languageServer}
        pending={pending}
        error={error}
        result={result}
        onRefreshIndex={() => void load("index-status")}
        target={target}
        onTargetChange={setTarget}
        survey={survey}
        surveyTarget={surveyTarget}
        onSurvey={() => void load("survey")}
        enabled={enabled}
        onEnabledChange={setEnabled}
        binaryPath={binaryPath}
        onBinaryPathChange={setBinary}
        settingsSaved={settingsSaved}
        onSaveSettings={() => void saveSettings()}
      />
    </PanelFrame>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "hyperfide-graph",
    title: "Index",
    icon: "GitBranch",
    path: "hyperfide-graph",
    component: IndexPanel,
  });
});
