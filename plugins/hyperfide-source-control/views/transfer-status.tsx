import { useState } from "react";
import {
  ConfirmDeleteDialog,
  ConfirmDeleteDialogContent,
} from "@hyperfide/shared-ui/confirm-delete-dialog";
import {
  Field,
  Receipt,
  inputClass,
  buttonClass,
  type RunSource,
} from "./shared.js";
interface Transfer {
  transfer_id: string;
  object_id: string;
  direction: string;
  state: string;
  size_bytes: string;
  transferred_bytes: string;
  verified: boolean;
  expires_at: string;
  error_code: string | null;
  parts: {
    part_index: number;
    offset_bytes: string;
    size_bytes: string;
    state: string;
  }[];
}
export function TransferStatus({
  run,
  pending,
}: {
  run: RunSource;
  pending: boolean;
}) {
  const [id, setId] = useState(""),
    [transfer, setTransfer] = useState<Transfer | null>(null),
    [confirmingCancel, setConfirmingCancel] = useState(false);
  const apply = async (action: Parameters<RunSource>[0]) => {
    const result = await run(action);
    if (result.ok) setTransfer(result.result as Transfer);
  };
  return (
    <div className="min-w-0 space-y-4 rounded-lg border border-border p-4">
      <h2 className="font-semibold">Object transfers</h2>
      <p className="text-sm text-muted-foreground">
        Inspect the progress of a source transfer, verify its completion, or
        cancel it before completion.
      </p>
      <Field label="Transfer">
        <input
          className={inputClass}
          value={id}
          onChange={(event) => setId(event.target.value)}
        />
      </Field>
      <button
        className={buttonClass}
        disabled={pending || !id}
        onClick={() => void apply({ kind: "transfer", transferId: id })}
      >
        Refresh transfer
      </button>
      {transfer && (
        <>
          <p className="break-words font-medium">
            {transfer.direction} · {transfer.state}
          </p>
          <p className="text-sm">
            {transfer.transferred_bytes} / {transfer.size_bytes} bytes ·{" "}
            {transfer.verified
              ? "Verified object"
              : transfer.direction === "DOWNLOAD" &&
                  transfer.state === "COMPLETED"
                ? "Download complete"
                : "Awaiting verification"}
          </p>
          <p className="break-words text-sm">Expires: {transfer.expires_at}</p>
          {transfer.error_code && (
            <p role="alert" className="break-words">
              {transfer.error_code}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              className={buttonClass}
              disabled={
                pending ||
                ["COMPLETED", "CANCELLED", "FAILED", "EXPIRED"].includes(
                  transfer.state,
                )
              }
              onClick={() =>
                void apply({
                  kind: "complete-transfer",
                  transferId: id,
                  objectId: transfer.object_id,
                })
              }
            >
              Verify completion
            </button>
            <button
              className={buttonClass}
              disabled={
                pending ||
                ["COMPLETED", "CANCELLED", "EXPIRED"].includes(transfer.state)
              }
              onClick={() => setConfirmingCancel(true)}
            >
              Cancel transfer
            </button>
          </div>
          <ol className="max-h-80 overflow-auto space-y-1 text-sm">
            {transfer.parts.slice(0, 256).map((part) => (
              <li key={part.part_index}>
                Part {part.part_index + 1}: {part.size_bytes} bytes ·{" "}
                {part.state}
              </li>
            ))}
          </ol>
          <Receipt value={transfer} />
        </>
      )}
      <ConfirmDeleteDialog
        open={confirmingCancel}
        onOpenChange={setConfirmingCancel}
      >
        <ConfirmDeleteDialogContent
          title="Cancel this transfer?"
          description="The transfer will stop before completion and its remaining parts will not be delivered."
          confirmLabel="Cancel transfer"
          pending={pending}
          onCancel={() => setConfirmingCancel(false)}
          onConfirm={() => {
            setConfirmingCancel(false);
            void apply({ kind: "cancel-transfer", transferId: id });
          }}
        />
      </ConfirmDeleteDialog>
    </div>
  );
}
