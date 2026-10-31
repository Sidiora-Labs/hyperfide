import type { PromptMentionResource } from "@hyperfide/domain";

export type PromptMentionLinkResolver = (
  resource: PromptMentionResource,
) => (() => void) | null;
