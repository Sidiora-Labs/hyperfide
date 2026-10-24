import type { PluginEnvironmentProviderProgress } from "@hyperfide/plugin-sdk/environment-provider";

export function createCloneProgressReporter(
  target: PluginEnvironmentProviderProgress,
) {
  let pending: string | null = null;
  let lastText: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastEmittedAt = Number.NEGATIVE_INFINITY;
  let disposed = false;

  async function flush() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (pending === null) return;
    const text = pending;
    pending = null;
    if (text === lastText) return;
    lastText = text;
    lastEmittedAt = Date.now();
    await target.log(text);
  }

  async function log(text: string) {
    if (disposed) return;
    pending = text;
    const delay = Math.max(0, 1_000 - (Date.now() - lastEmittedAt));
    if (delay === 0) await flush();
    else if (timer === null) {
      timer = setTimeout(flush, delay);
      timer.unref();
    }
  }

  return {
    report: { log, step: log } satisfies PluginEnvironmentProviderProgress,
    async dispose() {
      disposed = true;
      await flush();
    },
  };
}
