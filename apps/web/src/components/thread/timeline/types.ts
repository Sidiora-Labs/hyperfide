import type { ThreadChatMessageReference } from "@hyperfide/plugin-sdk";
import type { PromptInput } from "@hyperfide/domain";
import type {
  MarkdownPreviewLocalFileLink,
  MarkdownPreviewLocalFileLinkHandler,
} from "../../ui/markdown-local-file-link.js";
import type { MarkdownPreviewLinkHandler } from "../../ui/markdown-link.js";
import type { PromptDraftAttachment } from "@hyperfide/client-core";
import type { MarkdownMessageDirectiveOpenThreadPanel } from "@/components/ui/markdown-message-directives";

export type ThreadTimelineLocalFileLink = MarkdownPreviewLocalFileLink;

export type ThreadTimelineLocalFileLinkHandler =
  MarkdownPreviewLocalFileLinkHandler;

export type ThreadTimelineLinkHandler = MarkdownPreviewLinkHandler;

export type ThreadTimelineOpenPluginPanelHandler =
  MarkdownMessageDirectiveOpenThreadPanel;

interface ThreadTimelineForkMessageTarget {
  sourceSeqEnd: number;
}

export type ThreadTimelineForkMessageHandler = (
  target: ThreadTimelineForkMessageTarget,
) => void;

export interface ThreadTimelineEditMessageTarget {
  messageId: string;
  expectedRequestSequence: number;
  input: PromptInput[];
}

export type ThreadTimelineEditMessageHandler = (
  target: ThreadTimelineEditMessageTarget,
) => void;

export interface ThreadTimelineInlineMessageEditor {
  messageId: string;
  onHostElementChange: (element: HTMLDivElement | null) => void;
}

export type ThreadTimelineAddToChatHandler = (
  text: string,
  attachments?: readonly PromptDraftAttachment[],
) => void;

export interface ThreadTimelinePluginMessageAction {
  key: string;
  pluginId: string | null;
  icon: string | null;
  label: string;
  onSelect: () => void;
}

export interface ThreadTimelineConsumerMessageAction {
  id: string;
  pluginId: string | null;
  icon: string | null;
  label: string;
  roles?: readonly ("user" | "assistant")[];
  run(message: ThreadChatMessageReference): void | Promise<void>;
}

export type ThreadTimelineUnreadDividerPlacement =
  | {
      kind: "after-cutoff";
      cutoffAt: number;
    }
  | {
      kind: "before-first";
    };

export type UserAttachmentImageSrcResolver = (
  pathOrUrl: string,
  projectId?: string,
) => string;

export interface ThreadTimelineImageViewSrcTarget {
  path: string;
  threadId: string;
}

export type ThreadTimelineImageViewSrcResolver = (
  target: ThreadTimelineImageViewSrcTarget,
) => string;
