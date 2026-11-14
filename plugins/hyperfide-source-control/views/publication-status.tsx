import { useState } from "react";
import {
  ConfirmDeleteDialog,
  ConfirmDeleteDialogContent,
} from "@hyperfide/shared-ui/confirm-delete-dialog";
import {
  Field,
  Receipt,
  buttonClass,
  inputClass,
  type RunSource,
} from "./shared.js";
export function PublicationStatus({
  run,
  pending,
}: {
  run: RunSource;
  pending: boolean;
}) {
  const [acceptance, setAcceptance] = useState(""),
    [destination, setDestination] = useState(""),
    [ref, setRef] = useState(""),
    [expected, setExpected] = useState(""),
    [operation, setOperation] = useState(""),
    [receipt, setReceipt] = useState<any>(null),
    [confirmingCancel, setConfirmingCancel] = useState(false);
  const apply = async (action: Parameters<RunSource>[0]) => {
    const result = await run(action);
    if (result.ok) {
      setReceipt(result.result);
      const id = (result.result as any)?.operation_id;
      if (id) setOperation(id);
    }
  };
  return (
    <div className="min-w-0 space-y-5">
      <section className="space-y-3 rounded-lg border border-border p-4">
        <h2 className="font-semibold">Publish accepted source</h2>
        <p className="text-sm text-muted-foreground">
          Publication transfers an accepted revision to the configured Git
          remote and records its observed result.
        </p>
        <Field label="Acceptance receipt">
          <input
            className={inputClass}
            value={acceptance}
            onChange={(event) => setAcceptance(event.target.value)}
          />
        </Field>
        <Field label="Configured destination">
          <input
            className={inputClass}
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Target reference">
            <input
              className={inputClass}
              placeholder="refs/heads/main"
              value={ref}
              onChange={(event) => setRef(event.target.value)}
            />
          </Field>
          <Field label="Expected remote Git identity (empty for new reference)">
            <input
              className={inputClass}
              value={expected}
              onChange={(event) => setExpected(event.target.value)}
            />
          </Field>
        </div>
        <button
          className={buttonClass}
          disabled={pending || !acceptance || !destination || !ref}
          onClick={() =>
            void apply({
              kind: "publish",
              acceptanceId: acceptance,
              destinationId: destination,
              targetRef: ref,
              expectedOldOid: expected || null,
            })
          }
        >
          Create publication
        </button>
      </section>
      <section className="space-y-3 rounded-lg border border-border p-4">
        <h2 className="font-semibold">Publication status</h2>
        <Field label="Publication operation">
          <input
            className={inputClass}
            value={operation}
            onChange={(event) => setOperation(event.target.value)}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <button
            className={buttonClass}
            disabled={pending || !operation}
            onClick={() =>
              void apply({ kind: "publication", publicationId: operation })
            }
          >
            Refresh status
          </button>
          <button
            className={buttonClass}
            disabled={pending || !operation}
            onClick={() =>
              void apply({
                kind: "resume-publication",
                publicationId: operation,
              })
            }
          >
            Reconcile publication
          </button>
          <button
            className={buttonClass}
            disabled={pending || !operation}
            onClick={() => setConfirmingCancel(true)}
          >
            Cancel queued publication
          </button>
        </div>
        {receipt && (
          <>
            <p className="break-words font-medium">{receipt.status}</p>
            {receipt.git_oid && (
              <p className="break-all text-sm">
                Remote commit: {receipt.git_oid}
              </p>
            )}
            {receipt.code && (
              <p className="break-words text-sm">{receipt.code}</p>
            )}
          </>
        )}
      </section>
      <Receipt value={receipt} />
      <ConfirmDeleteDialog
        open={confirmingCancel}
        onOpenChange={setConfirmingCancel}
      >
        <ConfirmDeleteDialogContent
          title="Cancel queued publication?"
          description="The queued publication will be cancelled and must be recreated before it can be sent."
          confirmLabel="Cancel publication"
          pending={pending}
          onCancel={() => setConfirmingCancel(false)}
          onConfirm={() => {
            setConfirmingCancel(false);
            void apply({
              kind: "cancel-publication",
              publicationId: operation,
            });
          }}
        />
      </ConfirmDeleteDialog>
    </div>
  );
}
