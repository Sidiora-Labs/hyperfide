import { createBrowserBbSdk } from "@hyperfide/sdk/browser";
import { fetchWithAppSurface } from "./app-surface";

const BASE_URL =
  typeof window === "undefined" ? "http://localhost" : window.location.origin;

export const sdk = createBrowserBbSdk({
  baseUrl: BASE_URL,
  fetch: fetchWithAppSurface,
});

export { BbHttpError } from "@hyperfide/sdk/browser";
