import { jsonValueSchema } from "@hyperfide/domain";
import { z } from "zod";
import {
  desktopBrowserImportSelectionSchema,
  type DesktopBrowserImportOutcome,
  type DesktopBrowserImportSource,
} from "@hyperfide/host-daemon-contract";

export const HYPERFIDE_DESKTOP_BROWSER_MAX_URL_LENGTH = 4096;
export const HYPERFIDE_DESKTOP_BROWSER_MAX_TITLE_LENGTH = 1024;

export const hyperfideDesktopBrowserTargetSchema = z
  .object({
    hostId: z.string().min(1),
    instanceId: z.string().min(1),
    generation: z.string().min(1),
  })
  .strict();
export type HyperfideDesktopBrowserTarget = z.infer<
  typeof hyperfideDesktopBrowserTargetSchema
>;

export const hyperfideDesktopBrowserControlSchema = z
  .object({
    leaseId: z.string().min(1),
    controllerLabel: z.string().min(1),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type HyperfideDesktopBrowserControl = z.infer<
  typeof hyperfideDesktopBrowserControlSchema
>;
export const hyperfideDesktopBrowserControlStateSchema = z
  .object({
    tabId: z.string().min(1),
    threadId: z.string().min(1),
    control: hyperfideDesktopBrowserControlSchema.nullable(),
  })
  .strict();
export type HyperfideDesktopBrowserControlState = z.infer<
  typeof hyperfideDesktopBrowserControlStateSchema
>;
export const hyperfideDesktopBrowserRevealRequestSchema = z
  .object({
    tabId: z.string().min(1),
    threadId: z.string().min(1),
    desktopTarget: hyperfideDesktopBrowserTargetSchema,
  })
  .strict();
export type HyperfideDesktopBrowserRevealRequest = z.infer<
  typeof hyperfideDesktopBrowserRevealRequestSchema
>;

const hyperfideDesktopBrowserViewBoundsSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
  })
  .strict();
export type HyperfideDesktopBrowserViewBounds = z.infer<
  typeof hyperfideDesktopBrowserViewBoundsSchema
>;

export interface HyperfideDesktopBrowserViewportBounds {
  width: number;
  height: number;
}

interface ClampIntegerToRangeArgs {
  max: number;
  min: number;
  value: number;
}

interface ClampHyperfideDesktopBrowserViewBoundsArgs {
  bounds: HyperfideDesktopBrowserViewBounds;
  viewport: HyperfideDesktopBrowserViewportBounds;
}

function clampIntegerToRange(args: ClampIntegerToRangeArgs): number {
  return Math.min(Math.max(args.value, args.min), args.max);
}

export function clampHyperfideDesktopBrowserViewBounds(
  args: ClampHyperfideDesktopBrowserViewBoundsArgs,
): HyperfideDesktopBrowserViewBounds {
  const viewportRight = Math.max(0, Math.round(args.viewport.width));
  const viewportBottom = Math.max(0, Math.round(args.viewport.height));
  const x = clampIntegerToRange({
    value: args.bounds.x,
    min: 0,
    max: viewportRight,
  });
  const y = clampIntegerToRange({
    value: args.bounds.y,
    min: 0,
    max: viewportBottom,
  });
  const right = clampIntegerToRange({
    value: args.bounds.x + args.bounds.width,
    min: x,
    max: viewportRight,
  });
  const bottom = clampIntegerToRange({
    value: args.bounds.y + args.bounds.height,
    min: y,
    max: viewportBottom,
  });

  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
  };
}

export const hyperfideDesktopBrowserAttachRequestSchema = z
  .object({
    tabId: z.string().min(1),
    threadId: z.string().min(1),
    url: z.string().max(HYPERFIDE_DESKTOP_BROWSER_MAX_URL_LENGTH),
    existingOnly: z.literal(true).optional(),
    bounds: hyperfideDesktopBrowserViewBoundsSchema,
    visible: z.boolean(),
  })
  .strict();
export type HyperfideDesktopBrowserAttachRequest = z.infer<
  typeof hyperfideDesktopBrowserAttachRequestSchema
>;

export const hyperfideDesktopBrowserNavigateRequestSchema = z
  .object({
    tabId: z.string().min(1),
    url: z.string().min(1).max(HYPERFIDE_DESKTOP_BROWSER_MAX_URL_LENGTH),
  })
  .strict();
export type HyperfideDesktopBrowserNavigateRequest = z.infer<
  typeof hyperfideDesktopBrowserNavigateRequestSchema
>;

export const hyperfideDesktopBrowserSetBoundsRequestSchema = z
  .object({
    tabId: z.string().min(1),
    bounds: hyperfideDesktopBrowserViewBoundsSchema,
  })
  .strict();
export type HyperfideDesktopBrowserSetBoundsRequest = z.infer<
  typeof hyperfideDesktopBrowserSetBoundsRequestSchema
>;

export const hyperfideDesktopBrowserSetVisibleRequestSchema = z
  .object({
    tabId: z.string().min(1),
    visible: z.boolean(),
  })
  .strict();
export type HyperfideDesktopBrowserSetVisibleRequest = z.infer<
  typeof hyperfideDesktopBrowserSetVisibleRequestSchema
>;

export const hyperfideDesktopBrowserTabRefSchema = z
  .object({
    tabId: z.string().min(1),
  })
  .strict();
export type HyperfideDesktopBrowserTabRef = z.infer<
  typeof hyperfideDesktopBrowserTabRefSchema
>;

export const hyperfideDesktopBrowserSetThreadDiscardedRequestSchema = z
  .object({
    threadId: z.string().min(1),
    discarded: z.boolean(),
  })
  .strict();
export type HyperfideDesktopBrowserSetThreadDiscardedRequest = z.infer<
  typeof hyperfideDesktopBrowserSetThreadDiscardedRequestSchema
>;

export const hyperfideDesktopBrowserStateSchema = z
  .object({
    tabId: z.string().min(1),
    url: z.string().max(HYPERFIDE_DESKTOP_BROWSER_MAX_URL_LENGTH),
    title: z
      .string()
      .max(HYPERFIDE_DESKTOP_BROWSER_MAX_TITLE_LENGTH)
      .nullable(),
    faviconUrl: z
      .string()
      .max(HYPERFIDE_DESKTOP_BROWSER_MAX_URL_LENGTH)
      .nullable()
      .optional(),
    faviconUrls: z
      .array(z.string().max(HYPERFIDE_DESKTOP_BROWSER_MAX_URL_LENGTH))
      .max(8)
      .optional(),
    isLoading: z.boolean(),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    errorText: z
      .string()
      .max(HYPERFIDE_DESKTOP_BROWSER_MAX_TITLE_LENGTH)
      .nullable(),
  })
  .strict();
export type HyperfideDesktopBrowserState = z.infer<typeof hyperfideDesktopBrowserStateSchema>;

export const hyperfideDesktopBrowserOpenTabRequestSchema = z
  .object({
    url: z.string().min(1).max(HYPERFIDE_DESKTOP_BROWSER_MAX_URL_LENGTH),
  })
  .strict();
export type HyperfideDesktopBrowserOpenTabRequest = z.infer<
  typeof hyperfideDesktopBrowserOpenTabRequestSchema
>;

export const hyperfideDesktopBrowserScopedOpenTabRequestSchema = z
  .object({
    tabId: z.string().min(1),
    url: z.string().min(1).max(HYPERFIDE_DESKTOP_BROWSER_MAX_URL_LENGTH),
  })
  .strict();
export type HyperfideDesktopBrowserScopedOpenTabRequest = z.infer<
  typeof hyperfideDesktopBrowserScopedOpenTabRequestSchema
>;

const HYPERFIDE_DESKTOP_BROWSER_MAX_SNAPSHOT_DATA_URL_LENGTH = 8_388_608;

export const hyperfideDesktopBrowserSnapshotSchema = z
  .object({
    tabId: z.string().min(1),
    dataUrl: z
      .string()
      .max(HYPERFIDE_DESKTOP_BROWSER_MAX_SNAPSHOT_DATA_URL_LENGTH)
      .nullable(),
  })
  .strict();
export type HyperfideDesktopBrowserSnapshot = z.infer<
  typeof hyperfideDesktopBrowserSnapshotSchema
>;

export const HYPERFIDE_DESKTOP_BROWSER_MAX_FIND_TEXT_LENGTH = 1024;

export const hyperfideDesktopBrowserFindInPageRequestSchema = z
  .object({
    tabId: z.string().min(1),
    text: z.string().min(1).max(HYPERFIDE_DESKTOP_BROWSER_MAX_FIND_TEXT_LENGTH),
    forward: z.boolean(),
    newSession: z.boolean(),
  })
  .strict();
export type HyperfideDesktopBrowserFindInPageRequest = z.infer<
  typeof hyperfideDesktopBrowserFindInPageRequestSchema
>;

export const hyperfideDesktopBrowserStopFindInPageRequestSchema = z
  .object({
    tabId: z.string().min(1),
    action: z.enum(["clearSelection", "keepSelection", "activateSelection"]),
  })
  .strict();
export type HyperfideDesktopBrowserStopFindInPageRequest = z.infer<
  typeof hyperfideDesktopBrowserStopFindInPageRequestSchema
>;

export const hyperfideDesktopBrowserFindResultSchema = z
  .object({
    tabId: z.string().min(1),
    requestId: z.number().int(),
    activeMatchOrdinal: z.number().int().nonnegative(),
    matches: z.number().int().nonnegative(),
    finalUpdate: z.boolean(),
  })
  .strict();
export type HyperfideDesktopBrowserFindResult = z.infer<
  typeof hyperfideDesktopBrowserFindResultSchema
>;

export const HYPERFIDE_DESKTOP_BROWSER_MAX_PAGE_EXPRESSION_LENGTH = 4_000_000;
export const HYPERFIDE_DESKTOP_BROWSER_MAX_PAGE_CHANNEL_LENGTH = 256;

export const hyperfideDesktopBrowserPageWorldSchema = z.enum(["main", "isolated"]);

export const hyperfideDesktopBrowserEvaluateRequestSchema = z
  .object({
    tabId: z.string().min(1),
    expression: z
      .string()
      .min(1)
      .max(HYPERFIDE_DESKTOP_BROWSER_MAX_PAGE_EXPRESSION_LENGTH),
    world: hyperfideDesktopBrowserPageWorldSchema,
    channel: z
      .string()
      .min(1)
      .max(HYPERFIDE_DESKTOP_BROWSER_MAX_PAGE_CHANNEL_LENGTH),
  })
  .strict();
export type HyperfideDesktopBrowserEvaluateRequest = z.infer<
  typeof hyperfideDesktopBrowserEvaluateRequestSchema
>;

export const hyperfideDesktopBrowserEvaluateResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: jsonValueSchema }).strict(),
  z.object({ ok: z.literal(false), error: z.string() }).strict(),
]);
export type HyperfideDesktopBrowserEvaluateResult = z.infer<
  typeof hyperfideDesktopBrowserEvaluateResultSchema
>;

export const hyperfideDesktopBrowserPageMessageSchema = z
  .object({
    tabId: z.string().min(1),
    channel: z
      .string()
      .min(1)
      .max(HYPERFIDE_DESKTOP_BROWSER_MAX_PAGE_CHANNEL_LENGTH),
    data: jsonValueSchema,
  })
  .strict();
export type HyperfideDesktopBrowserPageMessage = z.infer<
  typeof hyperfideDesktopBrowserPageMessageSchema
>;
export type HyperfideDesktopBrowserPageMessageHandler = (
  message: HyperfideDesktopBrowserPageMessage,
) => void;

export type HyperfideDesktopBrowserStateHandler = (
  state: HyperfideDesktopBrowserState,
) => void;
export type HyperfideDesktopBrowserOpenTabHandler = (
  request: HyperfideDesktopBrowserOpenTabRequest,
) => void;
export type HyperfideDesktopBrowserScopedOpenTabHandler = (
  request: HyperfideDesktopBrowserScopedOpenTabRequest,
) => void;
export type HyperfideDesktopBrowserSnapshotHandler = (
  snapshot: HyperfideDesktopBrowserSnapshot,
) => void;
export type HyperfideDesktopBrowserFocusHandler = (tabId: string) => void;
export type HyperfideDesktopBrowserFindResultHandler = (
  result: HyperfideDesktopBrowserFindResult,
) => void;
export type HyperfideDesktopBrowserUnsubscribe = () => void;

export const hyperfideDesktopBrowserImportCookiesRequestSchema =
  desktopBrowserImportSelectionSchema;
export type HyperfideDesktopBrowserImportCookiesRequest = z.infer<
  typeof hyperfideDesktopBrowserImportCookiesRequestSchema
>;
export type HyperfideDesktopBrowserImportSourcesResult = {
  sources: DesktopBrowserImportSource[];
};
export type HyperfideDesktopBrowserImportCookiesResult = DesktopBrowserImportOutcome;

export interface HyperfideDesktopBrowserApi {
  listImportSources?(): Promise<HyperfideDesktopBrowserImportSourcesResult>;
  importCookies?(
    request: HyperfideDesktopBrowserImportCookiesRequest,
  ): Promise<HyperfideDesktopBrowserImportCookiesResult>;
  openFullDiskAccessSettings?(): void;
  getTarget?(): Promise<HyperfideDesktopBrowserTarget | null>;
  getControl?(tabId: string): Promise<HyperfideDesktopBrowserControlState | null>;
  releaseControl?(tabId: string): void;
  onControl?(
    listener: (state: HyperfideDesktopBrowserControlState) => void,
  ): HyperfideDesktopBrowserUnsubscribe;
  onReveal?(
    listener: (request: HyperfideDesktopBrowserRevealRequest) => void,
  ): HyperfideDesktopBrowserUnsubscribe;
  attach(request: HyperfideDesktopBrowserAttachRequest): void;
  detach(tabId: string): void;
  setThreadDiscarded?(request: HyperfideDesktopBrowserSetThreadDiscardedRequest): void;
  listThreadIdsWithTabs?(): Promise<string[]>;
  navigate(request: HyperfideDesktopBrowserNavigateRequest): void;
  goBack(tabId: string): void;
  goForward(tabId: string): void;
  reload(tabId: string): void;
  stop(tabId: string): void;
  focus?(tabId: string): void;
  setBounds(request: HyperfideDesktopBrowserSetBoundsRequest): void;
  setVisible(request: HyperfideDesktopBrowserSetVisibleRequest): void;
  setVisibleWithoutFocus?(request: HyperfideDesktopBrowserSetVisibleRequest): void;
  onState(listener: HyperfideDesktopBrowserStateHandler): HyperfideDesktopBrowserUnsubscribe;
  onOpenTab(
    listener: HyperfideDesktopBrowserOpenTabHandler,
  ): HyperfideDesktopBrowserUnsubscribe;
  onScopedOpenTab?(
    listener: HyperfideDesktopBrowserScopedOpenTabHandler,
  ): HyperfideDesktopBrowserUnsubscribe;
  onFocus?(listener: HyperfideDesktopBrowserFocusHandler): HyperfideDesktopBrowserUnsubscribe;
  onSnapshot?(
    listener: HyperfideDesktopBrowserSnapshotHandler,
  ): HyperfideDesktopBrowserUnsubscribe;
  findInPage?(request: HyperfideDesktopBrowserFindInPageRequest): void;
  stopFindInPage?(request: HyperfideDesktopBrowserStopFindInPageRequest): void;
  onFindResult?(
    listener: HyperfideDesktopBrowserFindResultHandler,
  ): HyperfideDesktopBrowserUnsubscribe;
  evaluate?(
    request: HyperfideDesktopBrowserEvaluateRequest,
  ): Promise<HyperfideDesktopBrowserEvaluateResult>;
  onPageMessage?(
    listener: HyperfideDesktopBrowserPageMessageHandler,
  ): HyperfideDesktopBrowserUnsubscribe;
}
