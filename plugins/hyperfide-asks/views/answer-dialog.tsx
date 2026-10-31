import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ResourceMeta } from "@/components/ui/resource-list";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { Ask } from "../src/inbox-adapter.js";
import { isSecretAnswer, kindPresentation, scopeLabel } from "./ask-kinds.js";
import { AskDeadline, AskKindPill } from "./ask-row.js";

export interface AnswerInput {
  repository: string;
  id: number;
  value: string;
  note: string;
  operator: string;
  sensitive: boolean;
}

const FIELD_ERROR_CLASS =
  "rounded-md border border-surface-destructive-border bg-surface-destructive px-2 py-1 text-xs text-destructive-text";

function ChoiceRow({
  id,
  value,
  label,
  description,
  emphasized = false,
}: {
  id: string;
  value: string;
  label: string;
  description?: string;
  emphasized?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-md border px-3 py-2",
        emphasized
          ? "border-surface-selected-border bg-surface-selected"
          : "border-border",
      )}
    >
      <RadioGroupItem id={id} value={value} className="mt-0.5" />
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={id} className="block cursor-pointer leading-5">
          {label}
        </Label>
        {description ? (
          <p className="text-xs leading-snug text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function AnswerDialog({
  ask,
  now,
  answer,
  onClose,
}: {
  ask: Ask;
  now: number;
  answer: (input: AnswerInput) => Promise<unknown>;
  onClose: () => void;
}) {
  const formId = useId();
  const [value, setValue] = useState(ask.recommendation || "");
  const [note, setNote] = useState("");
  const [operator, setOperator] = useState("");
  const [sensitive, setSensitive] = useState(ask.sensitive ?? false);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const kind = kindPresentation(ask.kind);
  const secret = isSecretAnswer(ask, sensitive);
  const options = ask.options ?? [];
  const choices = !secret && ask.kind !== "permission" && options.length > 0;
  const valueId = `${formId}-value`;
  const noteId = `${formId}-note`;
  const operatorId = `${formId}-operator`;
  const sensitiveId = `${formId}-sensitive`;
  const choiceLabelId = `${formId}-choice-label`;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!value.trim()) {
      setError(
        ask.kind === "permission"
          ? "Choose whether to grant or refuse."
          : choices
            ? "Choose one of the offered options."
            : "An answer is required.",
      );
      return;
    }
    if (ask.kind === "permission" && !operator.trim()) {
      setError("Your operator identity is required to answer a permission.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await answer({
        repository: ask.repository,
        id: ask.id,
        value,
        note,
        operator,
        sensitive,
      });
      setValue("");
      onClose();
    } catch {
      setError("Answer could not be saved. Please retry.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        aria-label={`Answer: ${ask.question}`}
        className="max-w-xl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-start gap-2 pr-6">
            <Icon
              name={kind.icon}
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <span className="min-w-0 break-words">{ask.question}</span>
          </DialogTitle>
          <DialogDescription asChild>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <AskKindPill kind={ask.kind} />
              <ResourceMeta
                items={[
                  scopeLabel(ask),
                  <AskDeadline deadline={ask.deadline} now={now} />,
                ]}
              />
            </div>
          </DialogDescription>
        </DialogHeader>
        <p className="text-xs leading-snug text-muted-foreground">
          {kind.hint}
        </p>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => void submit(event)}
        >
          {ask.kind === "variable" ? (
            <div className="flex items-start gap-2.5">
              <Checkbox
                id={sensitiveId}
                checked={sensitive}
                disabled={busy || ask.sensitive === true}
                onCheckedChange={(checked) => setSensitive(checked === true)}
                className="mt-0.5"
              />
              <div className="min-w-0 space-y-0.5">
                <Label htmlFor={sensitiveId} className="cursor-pointer">
                  Sensitive
                </Label>
                <p className="text-xs leading-snug text-muted-foreground">
                  Store the value as a secret reference instead of plain text.
                </p>
              </div>
            </div>
          ) : null}
          {ask.kind === "permission" ? (
            <>
              <div className="space-y-2">
                <Label id={choiceLabelId}>Permission</Label>
                <RadioGroup
                  aria-labelledby={choiceLabelId}
                  value={value}
                  disabled={busy}
                  onValueChange={setValue}
                  className="gap-1.5"
                >
                  <ChoiceRow
                    id={`${formId}-approve`}
                    value="approve"
                    label="Grant"
                    description="Let the agent carry out the step it asked about."
                  />
                  <ChoiceRow
                    id={`${formId}-reject`}
                    value="reject"
                    label="Refuse"
                    description="Block the step. The agent keeps working on what does not depend on it."
                  />
                </RadioGroup>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={operatorId}>Operator identity</Label>
                <Input
                  id={operatorId}
                  required
                  autoComplete="off"
                  placeholder="Who is granting or refusing"
                  value={operator}
                  disabled={busy}
                  onChange={(event) => setOperator(event.target.value)}
                />
              </div>
            </>
          ) : choices ? (
            <div className="space-y-2">
              <Label id={choiceLabelId}>Answer</Label>
              <RadioGroup
                aria-labelledby={choiceLabelId}
                value={value}
                disabled={busy}
                onValueChange={setValue}
                className="gap-1.5"
              >
                {options.map((option, index) => {
                  const recommended = option === ask.recommendation;
                  return (
                    <ChoiceRow
                      key={option}
                      id={`${formId}-option-${index}`}
                      value={option}
                      label={recommended ? `${option} (recommended)` : option}
                      emphasized={recommended}
                    />
                  );
                })}
              </RadioGroup>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor={valueId}>Answer</Label>
              <div className="relative">
                <Input
                  id={valueId}
                  aria-label="Answer value"
                  type={secret && !revealed ? "password" : "text"}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  required
                  value={value}
                  disabled={busy}
                  className={cn(secret && "pr-11 font-mono")}
                  onChange={(event) => setValue(event.target.value)}
                />
                {secret ? (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="absolute right-1 top-1/2 size-7 -translate-y-1/2 text-muted-foreground"
                    aria-label={`${revealed ? "Hide" : "Show"} answer`}
                    aria-pressed={revealed}
                    disabled={busy}
                    onClick={() => setRevealed((current) => !current)}
                  >
                    <Icon
                      name={revealed ? "EyeOff" : "Eye"}
                      className="size-4"
                      aria-hidden
                    />
                  </Button>
                ) : null}
              </div>
              {secret ? (
                <p className="text-xs leading-snug text-muted-foreground">
                  Saved as a secret reference. Notes are not kept for secret
                  answers.
                </p>
              ) : null}
            </div>
          )}
          {!secret ? (
            <div className="space-y-1.5">
              <Label htmlFor={noteId}>Note</Label>
              <Textarea
                id={noteId}
                rows={3}
                placeholder="Optional context for the agent"
                value={note}
                disabled={busy}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
          ) : null}
          {error ? (
            <p role="alert" className={FIELD_ERROR_CLASS}>
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? (
                <Icon name="Loading" className="animate-spin" aria-hidden />
              ) : null}
              Submit answer
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
