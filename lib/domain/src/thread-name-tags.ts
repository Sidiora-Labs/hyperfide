import type { ThreadEvent } from "./provider-event.js";

const HYPERFIDE_THREAD_NAME_PREFIX = "[hyperfide] ";

export function toProviderExternalThreadName(title: string): string {
  return `${HYPERFIDE_THREAD_NAME_PREFIX}${title}`;
}

export function fromProviderExternalThreadName(name: string): string {
  if (!name.startsWith(HYPERFIDE_THREAD_NAME_PREFIX)) {
    return name;
  }
  return name.slice(HYPERFIDE_THREAD_NAME_PREFIX.length);
}

export function normalizeProviderThreadNameEvent(
  event: ThreadEvent,
): ThreadEvent {
  if (event.type !== "thread/name/updated") {
    return event;
  }
  return {
    ...event,
    threadName: fromProviderExternalThreadName(event.threadName),
  };
}
