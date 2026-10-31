import { createBrowserHyperfideSdk } from "@hyperfide/sdk/browser";
import { fetchWithAppSurface } from "./app-surface";

const BASE_URL =
  typeof window === "undefined" ? "http://localhost" : window.location.origin;

export const sdk = createBrowserHyperfideSdk({
  baseUrl: BASE_URL,
  fetch: fetchWithAppSurface,
});

export { HyperfideHttpError } from "@hyperfide/sdk/browser";
