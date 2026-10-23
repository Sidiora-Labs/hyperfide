import { describe, expect, it } from "vitest";
import { threadScope } from "../src/thread-event-scope.js";
import type { ThreadEvent } from "../src/provider-event.js";
import {
  fromProviderExternalThreadName,
  normalizeProviderThreadNameEvent,
  toProviderExternalThreadName,
} from "../src/thread-name-tags.js";

describe("thread name tags", () => {
  it("round-trips user-provided literal hyperfide-prefixed titles", () => {
    const providerName = toProviderExternalThreadName("[hyperfide] Literal");

    expect(providerName).toBe("[hyperfide] [hyperfide] Literal");
    expect(fromProviderExternalThreadName(providerName)).toBe("[hyperfide] Literal");
  });

  it("normalizes provider title events by stripping one hyperfide tag", () => {
    const event = {
      type: "thread/name/updated",
      threadId: "t1",
      providerThreadId: "p1",
      scope: threadScope(),
      threadName: toProviderExternalThreadName("[hyperfide] Literal"),
    } satisfies ThreadEvent;

    expect(normalizeProviderThreadNameEvent(event)).toEqual({
      ...event,
      threadName: "[hyperfide] Literal",
    });
  });
});
