import { createHash } from "node:crypto";
import type {
  ClientTurnRequestId,
  ThreadDelta,
} from "@hyperfide/plugin-sdk/provider-bridge";
import { createClaudeDeltaTranslator } from "./delta-translation.js";

/** Adapts persisted Claude messages to the same translator used by the live bridge. */
export function createClaudeTranscriptTranslator(options: {
  cwd: string;
  threadId: string;
}) {
  const translator = createClaudeDeltaTranslator({
    cwd: options.cwd,
    sandboxEnabled: false,
  });
  let inputOrdinal = 0;
  return {
    translate(record: Record<string, unknown>): ThreadDelta[] {
      if (
        ![
          "user",
          "assistant",
          "system",
          "result",
          "stream_event",
          "rate_limit_event",
        ].includes(String(record.type))
      )
        return [];
      const message = record.message as { content?: unknown } | undefined;
      const content = message?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((part) => part?.type === "text")
                .map((part) => part.text)
                .join("\n")
            : "";
      const isToolResult =
        Array.isArray(content) &&
        content.some((part) => part?.type === "tool_result");
      const deltas: ThreadDelta[] = [];
      if (
        record.type === "user" &&
        !isToolResult &&
        text &&
        record.isMeta !== true &&
        record.isSynthetic !== true &&
        record.parent_tool_use_id == null
      ) {
        if (translator.hasOpenTurn(options.threadId))
          deltas.push(
            ...translator.buildSessionSettlementDeltas(options.threadId),
          );
        const alphabet = "23456789abcdefghijkmnpqrstuvwxyz";
        const hash = createHash("sha256")
          .update(`${options.threadId}:${++inputOrdinal}`)
          .digest();
        const requestId =
          `creq_${Array.from(hash.subarray(0, 10), (byte) => alphabet[byte % alphabet.length]).join("")}` as ClientTurnRequestId;
        deltas.push(...translator.acceptInput(options.threadId, requestId));
        deltas.push({ kind: "input.provider", text });
      }
      deltas.push(
        ...translator.translate(
          {
            ...record,
            session_id:
              record.session_id ?? record.sessionId ?? options.threadId,
            parent_tool_use_id: record.parent_tool_use_id ?? null,
            tool_use_result: record.tool_use_result ?? record.toolUseResult,
          },
          { threadId: options.threadId },
        ),
      );
      return deltas;
    },
    settle(): ThreadDelta[] {
      return translator.buildSessionSettlementDeltas(options.threadId);
    },
  };
}
