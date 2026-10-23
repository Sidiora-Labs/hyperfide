import { createNodeHyperfideSdk, type HyperfideSdk } from "@hyperfide/sdk/node";
import type { Dispatcher } from "undici";

type CliRequestInit = RequestInit & { dispatcher?: Dispatcher };

export function cliFetch(
  input: RequestInfo | URL,
  init?: CliRequestInit,
): Promise<Response> {
  return fetch(input, init);
}

export function createCliHyperfideSdk(baseUrl: string): HyperfideSdk {
  return createNodeHyperfideSdk({ baseUrl, fetch: cliFetch });
}
