import {
  readRetryDiagnostic,
  retryDiagnosticContract,
} from "./src/diagnostics.js";
import {
  retryAvailabilityMethod,
  retryAvailabilitySchema,
  type RetryAvailability,
} from "./src/retry-contract.js";
import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import { registerProviderRetryCli } from "./src/cli.js";
import {
  DEFAULT_MAXIMUM_WAIT_MS,
  decideRetry,
  isRateLimitFailure,
} from "./src/retry-policy.js";

const MAXIMUM_WAIT_OPTIONS = ["6 hours", "24 hours", "No limit"] as const;

function maximumWaitMs(value: string): number | null {
  switch (value) {
    case "6 hours":
      return DEFAULT_MAXIMUM_WAIT_MS;
    case "24 hours":
      return 24 * 60 * 60 * 1_000;
    case "No limit":
      return null;
    default:
      throw new Error(
        `Unsupported maximum provider retry wait: ${String(value)}`,
      );
  }
}

export default async function plugin(hyperfide: HyperfidePluginApi) {
  const settings = hyperfide.settings.define({
    maximumWait: {
      type: "select",
      label: "Maximum automatic wait",
      description:
        "Do not schedule a subscription-limit retry when its reset is farther away than this.",
      options: [...MAXIMUM_WAIT_OPTIONS],
      default: "6 hours",
    },
  });
  const initialSettings = await settings.get();
  let maximumWait = maximumWaitMs(initialSettings.maximumWait);
  settings.onChange((next) => {
    maximumWait = maximumWaitMs(next.maximumWait);
  });

  hyperfide.rpc.register(retryDiagnosticContract, {
    "decision.get": ({ threadId }) => readRetryDiagnostic(hyperfide, threadId),
  });
  hyperfide.events.on("turn.failed", async (event) => {
    let availability: RetryAvailability = { kind: "not-routed" };
    if (isRateLimitFailure(event)) {
      const sources = await hyperfide.sdk.plugins.experimental_discoverRpc({
        method: retryAvailabilityMethod,
      });
      for (const source of sources) {
        try {
          const result = await hyperfide.sdk.plugins.callRpc({
            pluginId: source.pluginId,
            method: retryAvailabilityMethod,
            input: { threadId: event.threadId, requestId: event.requestId },
            outputSchema: retryAvailabilitySchema,
            signal: AbortSignal.timeout(5_000),
          });
          if (result.kind !== "not-routed") {
            availability = result;
            break;
          }
        } catch (error) {
          hyperfide.log.warn(
            `Retry availability failed for ${event.threadId}: ${String(error)}`,
          );
          availability = { kind: "unavailable", reason: "source-unavailable" };
        }
      }
    }
    const decision = decideRetry({
      availability,
      failure: event,
      maximumWaitMs: maximumWait,
      now: Date.now(),
      random: Math.random(),
    });
    const recordDecision = () =>
      hyperfide.storage.kv.set(`decision:${event.threadId}`, {
        requestId: event.requestId,
        observedAt: Date.now(),
        availability,
        decision,
      });
    if (decision.kind === "decline") {
      await recordDecision();
      hyperfide.log.info(
        `Automatic retry skipped for ${event.threadId}: ${decision.reason}${availability.kind === "unavailable" ? ` (${availability.reason})` : ""}.`,
      );
      return;
    }
    await hyperfide.sdk.threads.retry({
      threadId: event.threadId,
      turnRequestId: event.requestId,
      sendAt: decision.sendAt,
      reason: decision.reason,
    });
    await recordDecision();
  });

  registerProviderRetryCli(hyperfide);
}
