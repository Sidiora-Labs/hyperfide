import { useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@hyperfide/plugin-sdk/app";
import type { inboxContract } from "./src/contract.js";
import type { Ask } from "./src/bridge-projection.js";
import { countdown, filterAsks, kinds } from "./src/inbox.js";

export function InboxView({
  asks,
  answer,
}: {
  asks: Ask[];
  answer: (input: {
    repository: string;
    id: number;
    value: string;
    note: string;
    operator: string;
    sensitive: boolean;
  }) => Promise<unknown>;
}) {
  const [kind, setKind] = useState("");
  const [task, setTask] = useState("");
  const [selected, setSelected] = useState<Ask | null>(null);
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [operator, setOperator] = useState("");
  const [sensitive, setSensitive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const secret =
    selected?.kind === "secret" || selected?.sensitive || sensitive;
  return (
    <section className="space-y-4 p-4">
      <h1>Inbox</h1>
      <label>
        Kind{" "}
        <select
          aria-label="Kind"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="">All kinds</option>
          {kinds.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </label>
      <label>
        Task{" "}
        <select
          aria-label="Task"
          value={task}
          onChange={(e) => setTask(e.target.value)}
        >
          <option value="">All tasks</option>
          {[...new Set(asks.map((a) => a.task))].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      {filterAsks(asks, kind, task).map((a) => (
        <article className="rounded border p-3" key={`${a.repository}:${a.id}`}>
          <span className="rounded bg-muted px-2" aria-label="Kind badge">
            {a.kind}
          </span>{" "}
          <span>
            {a.repository} / {a.task}
          </span>
          <h2>{a.question}</h2>
          <time>{countdown(a.deadline, now)}</time>
          {a.recommendation && (
            <p className="bg-accent font-semibold">
              Recommended: {a.recommendation}
            </p>
          )}
          <button
            onClick={() => {
              setSelected(a);
              setValue(a.recommendation || "");
              setNote("");
              setSensitive(a.sensitive ?? false);
              setError("");
            }}
          >
            Answer
          </button>
        </article>
      ))}
      {selected && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Answer: ${selected.question}`}
          className="rounded border bg-background p-4"
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                await answer({
                  repository: selected.repository,
                  id: selected.id,
                  value,
                  note,
                  operator,
                  sensitive,
                });
                setValue("");
                setSelected(null);
              } catch {
                setError("Answer could not be saved. Please retry.");
              } finally {
                setBusy(false);
              }
            }}
          >
            <h2>{selected.question}</h2>
            {selected.kind === "variable" && (
              <label>
                <input
                  type="checkbox"
                  checked={sensitive}
                  disabled={selected.sensitive === true}
                  onChange={(e) => setSensitive(e.target.checked)}
                />
                Sensitive
              </label>
            )}
            {selected.kind === "permission" ? (
              <>
                <label>
                  Permission{" "}
                  <select
                    aria-label="Permission"
                    value={value}
                    required
                    onChange={(e) => setValue(e.target.value)}
                  >
                    <option value="">Choose</option>
                    <option value="approve">Grant</option>
                    <option value="reject">Refuse</option>
                  </select>
                </label>
                <label>
                  Operator identity{" "}
                  <input
                    required
                    value={operator}
                    onChange={(e) => setOperator(e.target.value)}
                  />
                </label>
              </>
            ) : !secret && selected.options?.length ? (
              <fieldset>
                <legend>Answer</legend>
                {selected.options.map((option) => (
                  <label
                    className={
                      option === selected.recommendation
                        ? "bg-accent font-semibold"
                        : ""
                    }
                    key={option}
                  >
                    <input
                      type="radio"
                      name="answer"
                      value={option}
                      checked={value === option}
                      onChange={() => setValue(option)}
                    />
                    {option}
                    {option === selected.recommendation ? " (recommended)" : ""}
                  </label>
                ))}
              </fieldset>
            ) : (
              <label>
                Answer{" "}
                <input
                  aria-label="Answer value"
                  type={secret ? "password" : "text"}
                  autoComplete="off"
                  required
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </label>
            )}
            {!secret && (
              <label>
                Note{" "}
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
            )}
            {error && <p role="alert">{error}</p>}
            <button disabled={busy}>Submit answer</button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setValue("");
                setSelected(null);
              }}
            >
              Cancel
            </button>
          </form>
        </div>
      )}
    </section>
  );
}
function Inbox() {
  const rpc = useRpc<typeof inboxContract>();
  const [asks, setAsks] = useState<Ask[]>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void rpc
        .call("inboxList", {})
        .then((rows) => {
          if (active) {
            setAsks(rows);
            setError(false);
          }
        })
        .catch(() => {
          if (active) setError(true);
        });
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [rpc]);
  return (
    <>
      {error && <p role="alert">Inbox could not be loaded.</p>}
      <InboxView
        asks={asks}
        answer={async (input) => {
          const result = await rpc.call("inboxAnswer", input);
          setAsks((rows) =>
            rows.filter(
              (row) =>
                row.id !== input.id || row.repository !== input.repository,
            ),
          );
          return result;
        }}
      />
    </>
  );
}
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "inbox",
    title: "Inbox",
    icon: "Inbox",
    path: "inbox",
    component: Inbox,
  });
});
