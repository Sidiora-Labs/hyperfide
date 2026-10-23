import {
  createHyperfideSdk,
  createBuiltinPlanCommandTextInput,
  type HyperfideSdk,
  type HyperfideSdkAreas,
} from "./core.js";
import { createHttpTransport } from "./transport-http.js";
import type {
  HyperfideRealtimeSocketFactory,
  HyperfideSdkContext,
  HyperfideSdkTransport,
} from "./transport.js";

export interface CreateBrowserTransportArgs {
  baseUrl?: string;
  fetch?: typeof fetch;
  realtimeUrl?: string;
  websocket?: HyperfideRealtimeSocketFactory;
}

export interface CreateBrowserHyperfideSdkArgs extends CreateBrowserTransportArgs {
  context?: HyperfideSdkContext;
}

export type BrowserHyperfideSdk = HyperfideSdkAreas;

export function createBrowserTransport(
  args: CreateBrowserTransportArgs = {},
): HyperfideSdkTransport {
  return createHttpTransport({
    baseUrl: args.baseUrl,
    fetch: args.fetch,
    realtimeUrl: args.realtimeUrl,
    runtime: "browser",
    websocket: args.websocket,
  });
}

export function createBrowserHyperfideSdk(
  args: CreateBrowserHyperfideSdkArgs = {},
): BrowserHyperfideSdk {
  return createHyperfideSdk({
    context: args.context,
    transport: createBrowserTransport(args),
  });
}

export { HyperfideHttpError, HyperfideRequestTimeoutError } from "./response.js";
export type { HyperfideHttpErrorArgs } from "./response.js";
export { createHyperfideSdk, createBuiltinPlanCommandTextInput, createHttpTransport };
export type { HyperfideSdk, HyperfideSdkAreas, HyperfideSdkContext, HyperfideSdkTransport };
export type * from "./areas/skills.js";
export type * from "./public-types.js";
