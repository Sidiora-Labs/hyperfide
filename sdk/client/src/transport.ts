import type { ApiClient } from "@hyperfide/server-contract";
import type {
  FetchImplementation,
  JsonBodyOf,
  SdkResponseLike,
} from "./response.js";

export type HyperfideSdkRuntime = "node" | "browser";

export interface HyperfideSdkTransport {
  api: ApiClient["api"];
  baseUrl: string;
  fetch: FetchImplementation;
  realtimeUrl?: string;
  runtime: HyperfideSdkRuntime;
  readJson<TResponse extends SdkResponseLike>(
    response: Promise<TResponse>,
  ): Promise<JsonBodyOf<TResponse>>;
  readVoid<TResponse extends SdkResponseLike>(
    response: Promise<TResponse>,
  ): Promise<void>;
  resolve<TResponse extends SdkResponseLike>(
    response: Promise<TResponse>,
  ): Promise<TResponse>;
  websocket?: HyperfideRealtimeSocketFactory;
}

export interface HyperfideRealtimeSocketMessageEvent {
  data: unknown;
}

export interface HyperfideRealtimeSocket {
  close(): void;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: HyperfideRealtimeSocketMessageEvent) => void) | null;
  onopen: (() => void) | null;
  readyState: number;
  send(data: string): void;
}

export type HyperfideRealtimeSocketFactory = (url: string) => HyperfideRealtimeSocket;

export interface HyperfideSdkContext {}

export interface CreateHttpTransportArgs {
  baseUrl?: string;
  fetch?: FetchImplementation;
  realtimeUrl?: string;
  runtime: HyperfideSdkRuntime;
  websocket?: HyperfideRealtimeSocketFactory;
}
