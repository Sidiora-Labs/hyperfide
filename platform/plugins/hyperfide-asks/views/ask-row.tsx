import { Button } from "@/components/ui/button";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { Icon } from "@/components/ui/icon";
import { Pill } from "@/components/ui/pill";
import { ResourceMeta, ResourceRow } from "@/components/ui/resource-list";
import { cn } from "@/lib/utils";
import type { Ask } from "../src/inbox-adapter.js";
import { kindPresentation, scopeLabel } from "./ask-kinds.js";

function remainingMinutes(deadline: Ask["deadline"], now: number): number | null {
  if (!deadline) return null;
  const end =
    typeof deadline === "number" ? deadline * 1000 : Date.parse(deadline);
  if (!Number.isFinite(end)) return null;
  return Math.ceil((end - now) / 60000);
}

export function remainingLabel(deadline: Ask["deadline"], now: number): string {
  const minutes = remainingMinutes(deadline, now);
  if (minutes === null) return "No deadline";
  if (minutes <= 0) return "Overdue";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h remaining`;
  if (hours > 0) return `${hours}h ${minutes % 60}m remaining`;
  return `${minutes}m remaining`;
}

export function AskDeadline({
  deadline,
  now,
  className,
}: {
  deadline: Ask["deadline"];
  now: number;
  className?: string;
}) {
  const remaining = remainingLabel(deadline, now);
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
  const compact = useIsCompactViewport();
  const optionCount = ask.options?.length ?? 0;
  const deadline = <AskDeadline deadline={ask.deadline} now={now} />;
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
      titleMeta={compact ? undefined : scopeLabel(ask)}
      state={<AskKindPill kind={ask.kind} />}
      description={
        <ResourceMeta
          items={[
            compact ? deadline : null,
            compact ? scopeLabel(ask) : null,
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
      trailingMeta={compact ? undefined : deadline}
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
