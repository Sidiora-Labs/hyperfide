import { useCallback, useEffect, useState, type ReactNode } from "react";
import { definePluginApp, useRpc } from "@hyperfide/plugin-sdk/app";
import type { inboxContract } from "./src/contract.js";
import type { Ask } from "./src/inbox-adapter.js";
import { InboxView } from "./views/inbox-view.js";

export { InboxView } from "./views/inbox-view.js";

const PANEL_PATH = "inbox";
const REFRESH_INTERVAL_MS = 3000;

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

function Inbox() {
  const rpc = useRpc<typeof inboxContract>();
  const [asks, setAsks] = useState<Ask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void rpc
        .call("inboxList", {})
        .then((rows) => {
          if (!active) return;
          setAsks(rows);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (active) setError(errorText(cause));
        });
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [rpc, generation]);
  const retry = useCallback(() => {
    setAsks(null);
    setError(null);
    setGeneration((current) => current + 1);
  }, []);
  const answer = useCallback(
    async (input: {
      repository: string;
      id: number;
      value: string;
      note: string;
      operator: string;
      sensitive: boolean;
    }) => {
      const result = await rpc.call("inboxAnswer", input);
      setAsks((rows) =>
        rows === null
          ? rows
          : rows.filter(
              (row) =>
                row.id !== input.id || row.repository !== input.repository,
            ),
      );
      return result;
    },
    [rpc],
  );
  return (
    <PanelFrame>
      <InboxView asks={asks} error={error} onRetry={retry} answer={answer} />
    </PanelFrame>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "inbox",
    title: "Inbox",
    icon: "Inbox",
    path: PANEL_PATH,
    component: Inbox,
  });
});
