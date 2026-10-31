import type { IconName } from "@/components/ui/icon";
import type { Ask, Kind } from "../src/inbox-adapter.js";

export interface KindPresentation {
  label: string;
  icon: IconName;
  hint: string;
}

export const KIND_PRESENTATION: Record<Kind, KindPresentation> = {
  secret: {
    label: "Secret",
    icon: "Lock",
    hint: "Stored as a secret reference. The agent only ever sees the reference.",
  },
  variable: {
    label: "Variable",
    icon: "Settings",
    hint: "A configuration value, path or endpoint the task needs.",
  },
  permission: {
    label: "Permission",
    icon: "SecurityCheck",
    hint: "Approval before a destructive step, a new dependency or work outside the task.",
  },
  decision: {
    label: "Decision",
    icon: "Fork",
    hint: "A design choice. The agent proceeds on its recommendation until you answer.",
  },
  question: {
    label: "Question",
    icon: "MessageQuestion",
    hint: "A reading of an ambiguous criterion. The agent proceeds on its recommendation until you answer.",
  },
};

export function kindPresentation(kind: Ask["kind"]): KindPresentation {
  return KIND_PRESENTATION[kind] ?? KIND_PRESENTATION.question;
}

export function isSecretAnswer(ask: Ask, sensitive: boolean): boolean {
  return ask.kind === "secret" || ask.sensitive === true || sensitive;
}

export function scopeLabel(ask: Pick<Ask, "repository" | "task">): string {
  return `${ask.repository} / ${ask.task}`;
}
