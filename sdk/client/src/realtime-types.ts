import type { ChangedMessage } from "@hyperfide/domain";

export type HyperfideRealtimeUnsubscribe = () => void;

export type HyperfideRealtimeEventName =
  | "thread:changed"
  | "project:changed"
  | "environment:changed"
  | "host:changed"
  | "system:changed"
  | "system:config-changed"
  | "realtime:connection";

export type ThreadRealtimeEvent = Extract<ChangedMessage, { entity: "thread" }>;
export type ProjectRealtimeEvent = Extract<
  ChangedMessage,
  { entity: "project" }
>;
export type EnvironmentRealtimeEvent = Extract<
  ChangedMessage,
  { entity: "environment" }
>;
export type HostRealtimeEvent = Extract<ChangedMessage, { entity: "host" }>;
export type SystemRealtimeEvent = Extract<ChangedMessage, { entity: "system" }>;

export type HyperfideRealtimeConnectionState =
  | "connecting"
  | "connected"
  | "disconnected";

export interface HyperfideRealtimeConnectionEvent {
  reconnectDelayMs: number | null;
  reconnected: boolean;
  state: HyperfideRealtimeConnectionState;
}

export interface HyperfideRealtimeEventMap {
  "thread:changed": ThreadRealtimeEvent;
  "project:changed": ProjectRealtimeEvent;
  "environment:changed": EnvironmentRealtimeEvent;
  "host:changed": HostRealtimeEvent;
  "system:changed": SystemRealtimeEvent;
  "system:config-changed": SystemRealtimeEvent;
  "realtime:connection": HyperfideRealtimeConnectionEvent;
}

export type HyperfideRealtimeCallback<TEventName extends HyperfideRealtimeEventName> = (
  event: HyperfideRealtimeEventMap[TEventName],
) => void;

export interface ThreadRealtimeSubscribeArgs {
  callback: HyperfideRealtimeCallback<"thread:changed">;
  event: "thread:changed";
  threadId?: string;
}

export interface ProjectRealtimeSubscribeArgs {
  callback: HyperfideRealtimeCallback<"project:changed">;
  event: "project:changed";
  projectId?: string;
}

export interface EnvironmentRealtimeSubscribeArgs {
  callback: HyperfideRealtimeCallback<"environment:changed">;
  environmentId?: string;
  event: "environment:changed";
}

export interface HostRealtimeSubscribeArgs {
  callback: HyperfideRealtimeCallback<"host:changed">;
  event: "host:changed";
  hostId?: string;
}

export interface SystemRealtimeSubscribeArgs {
  callback: HyperfideRealtimeCallback<"system:changed">;
  event: "system:changed";
}

export interface SystemConfigRealtimeSubscribeArgs {
  callback: HyperfideRealtimeCallback<"system:config-changed">;
  event: "system:config-changed";
}

export interface RealtimeConnectionSubscribeArgs {
  callback: HyperfideRealtimeCallback<"realtime:connection">;
  event: "realtime:connection";
}

export type HyperfideRealtimeSubscribeArgsUnion =
  | ThreadRealtimeSubscribeArgs
  | ProjectRealtimeSubscribeArgs
  | EnvironmentRealtimeSubscribeArgs
  | HostRealtimeSubscribeArgs
  | SystemRealtimeSubscribeArgs
  | SystemConfigRealtimeSubscribeArgs
  | RealtimeConnectionSubscribeArgs;

export type HyperfideRealtimeSubscribeArgs<
  TEventName extends HyperfideRealtimeEventName = HyperfideRealtimeEventName,
> = Extract<HyperfideRealtimeSubscribeArgsUnion, { event: TEventName }>;

export interface HyperfideRealtime {
  subscribe<TEventName extends HyperfideRealtimeEventName>(
    args: HyperfideRealtimeSubscribeArgs<TEventName>,
  ): HyperfideRealtimeUnsubscribe;
}
