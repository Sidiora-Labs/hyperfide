import { useState } from "react";
import {
  Field,
  Receipt,
  RevisionInput,
  buttonClass,
  inputClass,
  type RunSource,
} from "./shared.js";
export function ChangeDetail({
  run,
  pending,
  revisions,
}: {
  run: RunSource;
  pending: boolean;
  revisions: { id: string; label: string }[];
}) {
  const [revision, setRevision] = useState(revisions[0]?.id ?? ""),
    [before, setBefore] = useState(""),
    [history, setHistory] = useState<any>(null),
    [comparison, setComparison] = useState<any>(null);
  const [transformation, setTransformation] = useState<any>(null),
    [resolved, setResolved] = useState("");
  const [candidate, setCandidate] = useState(""),
    [evidence, setEvidence] = useState(""),
    [qualification, setQualification] = useState(""),
    [receipt, setReceipt] = useState<unknown>();
  const readHistory = async (cursor?: string) => {
    const result = await run({
      kind: "history",
      revisionId: revision,
      ...(cursor ? { cursor } : {}),
    });
    if (result.ok) setHistory(result.result);
  };
  const compare = async (cursor?: string) => {
    const result = await run({
      kind: "diff",
      beforeRevisionId: before,
      afterRevisionId: revision,
      ...(cursor ? { cursor } : {}),
    });
    if (result.ok) setComparison(result.result);
  };
  return (
    <div className="space-y-5">
      <section className="space-y-3 rounded-lg border border-border p-4">
        <h2 className="font-semibold">History and changes</h2>
        <RevisionInput
          value={revision}
          onChange={setRevision}
          revisions={revisions}
        />
        <button
          className={buttonClass}
          disabled={pending || !revision}
          onClick={() => void readHistory()}
        >
          Read history
        </button>
        {history && (
          <div className="space-y-2">
            {history.entries?.map((entry: any) => (
              <article
                key={entry.revision_id}
                className="min-w-0 rounded border border-border p-3"
              >
                <p className="text-sm">
                  {entry.descriptor?.provenance?.message ?? "Source revision"}
                </p>
                <code className="break-all text-xs">{entry.revision_id}</code>
              </article>
            ))}
            <p className="text-xs">Coverage: {history.coverage?.state}</p>
            {history.next_cursor && (
              <button
                className={buttonClass}
                disabled={pending}
                onClick={() => void readHistory(history.next_cursor)}
              >
                Next history page
              </button>
            )}
          </div>
        )}
        <RevisionInput
          label="Compare from"
          value={before}
          onChange={setBefore}
          revisions={revisions}
        />
        <button
          className={buttonClass}
          disabled={pending || !before || !revision}
          onClick={() => void compare()}
        >
          Compare revisions
        </button>
        {comparison && (
          <div className="space-y-2">
            {comparison.entries?.map((entry: any) => (
              <p key={entry.path} className="break-all text-sm">
                <strong>{entry.kind}</strong> {entry.path}
              </p>
            ))}
            <p className="text-xs">Coverage: {comparison.coverage?.state}</p>
            {comparison.next_cursor && (
              <button
                className={buttonClass}
                disabled={pending}
                onClick={() => void compare(comparison.next_cursor)}
              >
                Next changes page
              </button>
            )}
          </div>
        )}
      </section>
      <section className="space-y-3 rounded-lg border border-border p-4">
        <h2 className="font-semibold">Merge and conflicts</h2>
        <p className="text-sm text-muted-foreground">
          Merge the two revisions selected above. Conflicts retain their
          operation for resolution.
        </p>
        <button
          className={buttonClass}
          disabled={pending || !before || !revision}
          onClick={() =>
            void run({
              kind: "merge",
              oursRevisionId: before,
              theirsRevisionId: revision,
              createdAt: new Date().toISOString(),
            }).then((result) => {
              if (result.ok) {
                setTransformation(result.result);
                setReceipt(result.result);
              }
            })
          }
        >
          Merge revisions
        </button>
        {transformation && (
          <>
            <p className="text-sm">{transformation.status}</p>
            {transformation.conflicts?.map((conflict: any) => (
              <p key={conflict.conflict_id} className="break-all text-sm">
                <strong>{conflict.kind}</strong> {conflict.path}
              </p>
            ))}
            {transformation.status === "CONFLICT" && (
              <>
                <RevisionInput
                  label="Resolved workspace revision"
                  value={resolved}
                  onChange={setResolved}
                  revisions={revisions}
                />
                <button
                  className={buttonClass}
                  disabled={pending || !resolved}
                  onClick={() =>
                    void run({
                      kind: "resolve-conflict",
                      transformationId: transformation.operation_id,
                      conflictId: transformation.conflict_id,
                      resolvedRevisionId: resolved,
                      expectedGeneration: transformation.generation,
                    }).then((result) => {
                      if (result.ok) {
                        setTransformation(result.result);
                        setReceipt(result.result);
                      }
                    })
                  }
                >
                  Apply resolved revision
                </button>
              </>
            )}
          </>
        )}
      </section>
      <section className="space-y-3 rounded-lg border border-border p-4">
        <h2 className="font-semibold">Qualification and acceptance</h2>
        <Field label="Candidate">
          <input
            className={inputClass}
            value={candidate}
            onChange={(event) => setCandidate(event.target.value)}
          />
        </Field>
        <button
          className={buttonClass}
          disabled={pending || !candidate}
          onClick={() =>
            void run({ kind: "candidate", candidateId: candidate }).then(
              (result) => {
                if (result.ok) setReceipt(result.result);
              },
            )
          }
        >
          Inspect candidate
        </button>
        <Field label="Independent evidence IDs (one per line)">
          <textarea
            className={inputClass}
            value={evidence}
            onChange={(event) => setEvidence(event.target.value)}
          />
        </Field>
        <button
          className={buttonClass}
          disabled={pending || !candidate || !evidence.trim()}
          onClick={() =>
            void run({
              kind: "qualify",
              candidateId: candidate,
              evidenceIds: evidence
                .split("\n")
                .map((id) => id.trim())
                .filter(Boolean),
            }).then((result) => {
              if (result.ok) {
                setQualification((result.result as any).qualification_id);
                setReceipt(result.result);
              }
            })
          }
        >
          Qualify candidate
        </button>
        <Field label="Qualification">
          <input
            className={inputClass}
            value={qualification}
            onChange={(event) => setQualification(event.target.value)}
          />
        </Field>
        <button
          className={buttonClass}
          disabled={pending || !candidate || !qualification}
          onClick={() =>
            void run({
              kind: "accept",
              candidateId: candidate,
              qualificationId: qualification,
            }).then((result) => {
              if (result.ok) setReceipt(result.result);
            })
          }
        >
          Accept qualified candidate
        </button>
      </section>
      <Receipt value={receipt} />
    </div>
  );
}
