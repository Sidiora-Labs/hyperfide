/** The subset of the SDK used here, also usable by a scripted provider in tests. */
export interface AskThreadSdk {
  stop(args: { threadId: string }): Promise<unknown>;
  send(args: {
    threadId: string;
    input: { type: "text"; text: string; mentions: never[] }[];
    mode: "queue-if-active";
  }): Promise<unknown>;
  updatePluginMetadata(args: {
    threadId: string;
    pluginId: string;
    set: Record<string, import("@hyperfide/domain").JsonValue>;
  }): Promise<unknown>;
}

/** Adapt the server SDK for the additive plugin lifecycle capability. */
export function createAskThreadOperations(sdk: AskThreadSdk) {
  return {
    async stop(threadId: string) { await sdk.stop({ threadId }); },
    async send(threadId: string, message: string) {
      await sdk.send({ threadId, input: [{ type: "text", text: message, mentions: [] }], mode: "queue-if-active" });
    },
    async record(threadId: string, event: {
      askId: string; task: string; reason: string;
    } | {
      askId: string; task: string; flagged: true; recommendation: string;
    } | { resumed: true }) {
      const set: Record<string, import("@hyperfide/domain").JsonValue> = "resumed" in event
        ? { askPause: null }
        : "flagged" in event
          ? { [`askFlag:${event.askId}`]: { ...event } }
          : { askPause: { ...event } };
      await sdk.updatePluginMetadata({ threadId, pluginId: "hyperfide-asks", set });
    },
  };
}
