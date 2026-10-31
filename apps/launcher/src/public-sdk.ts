import {
  HyperfideHttpError,
  HyperfideRequestTimeoutError,
  ThreadWaitTimeoutError,
  ThreadWaitUnreachableError,
  createNodeHyperfideSdk,
  type HyperfideSdk as HyperfideSdkContract,
  type CreateNodeHyperfideSdkArgs,
} from "@hyperfide/sdk/node";
import type {
  HyperfideRealtimeSubscribeArgs,
  HyperfideRealtimeSocket,
  HyperfideRealtimeSocketFactory,
  HyperfideRealtimeSocketMessageEvent,
  ThreadGetResult,
  ThreadStatusArgs,
} from "@hyperfide/sdk/node";

export {
  HyperfideHttpError,
  HyperfideRequestTimeoutError,
  ThreadWaitTimeoutError,
  ThreadWaitUnreachableError,
};
export type * from "@hyperfide/sdk/node";
export type {
  GitBranchSelection,
  JsonValue,
  PermissionMode,
  PromptInput,
  PromptTextMention,
  ReasoningLevel,
  ServiceTier,
  ThreadStatus,
} from "@hyperfide/sdk/node";
export type {
  CreateExecutionInputSources,
  EnvironmentArgs,
  ExistingThreadExecutionInputSources,
  UnmanagedBranchSpec,
  WorkspaceArgs,
} from "@hyperfide/sdk/node";
export type { CallerExecutionInputSource as ExecutionInputSource } from "@hyperfide/sdk/node";

export type HyperfideSdkOptions = CreateNodeHyperfideSdkArgs;
export type HyperfideSdkRealtimeSubscribeArgs = HyperfideRealtimeSubscribeArgs;
export type HyperfideSdkRealtimeSocket = HyperfideRealtimeSocket;
export type HyperfideSdkRealtimeSocketFactory = HyperfideRealtimeSocketFactory;
export type HyperfideSdkRealtimeSocketMessageEvent = HyperfideRealtimeSocketMessageEvent;
export type HyperfideSdkStatusArea = HyperfideSdkContract["status"];
export type HyperfideSdkSkillsArea = HyperfideSdkContract["skills"];
export type HyperfideSdkTerminalsArea = HyperfideSdkContract["terminals"];
export type HyperfideSdkThread = ThreadGetResult;
export type HyperfideSdkThreadsArea = HyperfideSdkContract["threads"];
export type ThreadIdArgs = ThreadStatusArgs;
export type HyperfideHttpErrorConstructor = typeof HyperfideHttpError;
export type HyperfideRequestTimeoutErrorConstructor = typeof HyperfideRequestTimeoutError;
export type ThreadWaitTimeoutErrorConstructor = typeof ThreadWaitTimeoutError;
export type ThreadWaitUnreachableErrorConstructor =
  typeof ThreadWaitUnreachableError;

export class HyperfideSdk implements HyperfideSdkContract {
  readonly environments: HyperfideSdkContract["environments"];
  readonly experimental_desktopBrowsers: HyperfideSdkContract["experimental_desktopBrowsers"];
  readonly experimental_promptHistory: HyperfideSdkContract["experimental_promptHistory"];
  readonly experimental_server: HyperfideSdkContract["experimental_server"];
  readonly files: HyperfideSdkContract["files"];
  readonly guide: HyperfideSdkContract["guide"];
  readonly hosts: HyperfideSdkContract["hosts"];
  readonly plugins: HyperfideSdkContract["plugins"];
  readonly projects: HyperfideSdkContract["projects"];
  readonly providers: HyperfideSdkContract["providers"];
  readonly skills: HyperfideSdkContract["skills"];
  readonly status: HyperfideSdkContract["status"];
  readonly system: HyperfideSdkContract["system"];
  readonly terminals: HyperfideSdkContract["terminals"];
  readonly theme: HyperfideSdkContract["theme"];
  readonly threadSections: HyperfideSdkContract["threadSections"];
  readonly threads: HyperfideSdkContract["threads"];
  readonly subscribe: HyperfideSdkContract["subscribe"];

  constructor(options: HyperfideSdkOptions = {}) {
    const sdk = createNodeHyperfideSdk(options);
    this.environments = sdk.environments;
    this.experimental_desktopBrowsers = sdk.experimental_desktopBrowsers;
    this.experimental_promptHistory = sdk.experimental_promptHistory;
    this.experimental_server = sdk.experimental_server;
    this.files = sdk.files;
    this.guide = sdk.guide;
    this.hosts = sdk.hosts;
    this.plugins = sdk.plugins;
    this.projects = sdk.projects;
    this.providers = sdk.providers;
    this.skills = sdk.skills;
    this.status = sdk.status;
    this.system = sdk.system;
    this.terminals = sdk.terminals;
    this.theme = sdk.theme;
    this.threadSections = sdk.threadSections;
    this.threads = sdk.threads;
    this.subscribe = sdk.subscribe;
  }
}

export function createHyperfideSdk(options: HyperfideSdkOptions = {}): HyperfideSdk {
  return new HyperfideSdk(options);
}
