import { useId, type ReactNode } from "react";
import type { SourceActionInput, SourceProductResponse } from "../contract.js";
export type RunSource = (
  action: SourceActionInput,
) => Promise<SourceProductResponse>;
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
      {label}
      {children}
    </label>
  );
}
export const inputClass =
  "w-full min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm font-normal";
export const buttonClass =
  "rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-hover disabled:opacity-50";
export function Receipt({ value }: { value: unknown }) {
  if (value === undefined) return null;
  return (
    <details className="min-w-0 rounded-md border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium">
        Durable receipt and source identity
      </summary>
      <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}
export function RevisionInput({
  value,
  onChange,
  revisions,
  label = "Revision",
}: {
  value: string;
  onChange: (value: string) => void;
  revisions: { id: string; label: string }[];
  label?: string;
}) {
  const listId = useId();
  return (
    <Field label={label}>
      <input
        className={inputClass}
        list={listId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Select a named revision or paste its ID"
      />
      <datalist id={listId}>
        {revisions.map((revision) => (
          <option key={revision.id} value={revision.id}>
            {revision.label}
          </option>
        ))}
      </datalist>
    </Field>
  );
}
