import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";

export default function draftsPlugin(hyperfide: HyperfidePluginApi): void {
  hyperfide.experimental_hooks.on("message.dispatch", (context) => {
    const isNewDraft =
      context.experimental_submission?.pluginId === hyperfide.pluginId &&
      context.experimental_submission.data !== null &&
      typeof context.experimental_submission.data === "object" &&
      !Array.isArray(context.experimental_submission.data) &&
      context.experimental_submission.data.kind === "draft";
    const firstQueuedMessage = context.queuedMessages[0];
    const isQueuedDraft =
      firstQueuedMessage?.waitingOn?.kind === "plugin" &&
      firstQueuedMessage.waitingOn.pluginId === hyperfide.pluginId;
    return isNewDraft || isQueuedDraft
      ? { action: "wait", reason: "Draft" }
      : { action: "proceed" };
  });
}
