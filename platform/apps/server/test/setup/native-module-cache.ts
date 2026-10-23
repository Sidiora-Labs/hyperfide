import { execFile } from "node:child_process";
import { promisify } from "node:util";

export default async function warmNativeModuleCache(): Promise<void> {
  // Native loading tests use tsx's separate compiler cache, outside Vite's cache.
  const serviceUrl = new URL(
    "../../src/services/plugins/plugin-service.ts",
    import.meta.url,
  ).href;
  await promisify(execFile)(process.execPath, [
    "--conditions=source",
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    `await import(${JSON.stringify(serviceUrl)});`,
  ]);
}
