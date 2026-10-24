import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Pill } from "@/components/ui/pill";
import { ResourceMeta, ResourceRow } from "@/components/ui/resource-list";
import { cn } from "@/lib/utils";
import type { Ask } from "../src/inbox-adapter.js";
import { countdown } from "../src/inbox.js";
import { kindPresentation, scopeLabel } from "./ask-kinds.js";

export function AskDeadline({
  deadline,
  now,
  className,
}: {
  deadline: Ask["deadline"];
  now: number;
  className?: string;
}) {
  const remaining = countdown(deadline, now);
  const overdue = remaining === "Overdue";
  const open = remaining === "No deadline";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs tabular-nums",
        overdue ? "text-destructive" : "text-subtle-foreground",
        className,
      )}
    >
      <Icon
        name={overdue ? "AlertCircle" : "Clock"}
        className={cn("size-3.5 shrink-0", open && "opacity-60")}
        aria-hidden
      />
      <time>{remaining}</time>
    </span>
  );
}

export function AskKindPill({ kind }: { kind: Ask["kind"] }) {
  return (
    <Pill variant="outline" size="sm" className="shrink-0 self-center">
      {kindPresentation(kind).label}
    </Pill>
  );
}

export function AskRow({
  ask,
  now,
  onAnswer,
}: {
  ask: Ask;
  now: number;
  onAnswer: (ask: Ask) => void;
}) {
  const kind = kindPresentation(ask.kind);
  const optionCount = ask.options?.length ?? 0;
  return (
    <ResourceRow
      leading={
        <Icon
          name={kind.icon}
          className="size-4 text-muted-foreground"
          aria-hidden
        />
      }
      title={ask.question}
      titleMeta={scopeLabel(ask)}
      state={<AskKindPill kind={ask.kind} />}
      description={
        <ResourceMeta
          items={[
            ask.recommendation ? (
              <span className="font-medium text-foreground">
                Recommended: {ask.recommendation}
              </span>
            ) : null,
            optionCount > 0
              ? `${optionCount} ${optionCount === 1 ? "option" : "options"}`
              : null,
            ask.sensitive ? "Sensitive" : null,
            kind.hint,
          ]}
        />
      }
      trailingMeta={<AskDeadline deadline={ask.deadline} now={now} />}
      persistentActions={
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onAnswer(ask)}
        >
          Answer
        </Button>
      }
      actionsVisibility="always"
      onOpen={() => onAnswer(ask)}
    />
  );
}
