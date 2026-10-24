import type {
  ProviderRuntimeEvent,
  ThreadDelta,
} from "@hyperfide/plugin-sdk/provider-bridge";
import { createCodexEventTranslator } from "./translator.js";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** Reconstructs app-server notifications from persisted rollout response items. */
export function createCodexTranscriptTranslator(options: { threadId: string }) {
  const translator = createCodexEventTranslator({
    additionalWorkspaceWriteRoots: [],
  });
  let ordinal = 0;
  let turnId = "";
  let cwd = "";
  let nextTurnId = "";
  const calls = new Map<string, { name: string; arguments: string }>();
  function notify(
    method: string,
    params: Record<string, unknown>,
  ): ThreadDelta[] {
    // Rollouts are replayed sequentially; use the assembler's current turn so
    // provider input and translated items share one turn.
    return translator
      .translateEvent({
        jsonrpc: "2.0",
        method,
        params,
      } as ProviderRuntimeEvent)
      .map((delta) => {
        if (!("providerTurnId" in delta)) return delta;
        const { providerTurnId: _providerTurnId, ...rest } = delta;
        return rest;
      });
  }
  function open(): ThreadDelta[] {
    if (turnId) return [];
    turnId = nextTurnId || `import-turn-${++ordinal}`;
    nextTurnId = "";
    return notify("turn/started", {
      threadId: options.threadId,
      turn: { id: turnId, items: [], status: "inProgress", error: null },
    });
  }
  function complete(status = "completed"): ThreadDelta[] {
    if (!turnId) return [];
    const deltas = notify("turn/completed", {
      threadId: options.threadId,
      turn: { id: turnId, items: [], status, error: null },
    });
    turnId = "";
    return deltas;
  }
  function item(item: Record<string, unknown>): ThreadDelta[] {
    return notify("item/completed", {
      threadId: options.threadId,
      turnId,
      item,
    });
  }
  return {
    translate(record: Record<string, unknown>): ThreadDelta[] {
      const payload = object(record.payload);
      if (record.type === "session_meta" || record.type === "turn_context") {
        if (typeof payload.cwd === "string") cwd = payload.cwd;
        if (!turnId && typeof payload.turn_id === "string")
          nextTurnId = payload.turn_id;
        return [];
      }
      if (record.type === "event_msg") {
        if (payload.type === "task_complete") return complete();
        if (payload.type === "turn_aborted") return complete("interrupted");
        if (payload.type === "token_count" && turnId) {
          const info = object(payload.info);
          const usage = (value: unknown) => {
            const counters = object(value);
            return {
              totalTokens: Number(counters.total_tokens ?? 0),
              inputTokens: Number(counters.input_tokens ?? 0),
              cachedInputTokens: Number(counters.cached_input_tokens ?? 0),
              cacheWriteInputTokens: Number(
                counters.cache_write_input_tokens ?? 0,
              ),
              outputTokens: Number(counters.output_tokens ?? 0),
              reasoningOutputTokens: Number(
                counters.reasoning_output_tokens ?? 0,
              ),
            };
          };
          return notify("thread/tokenUsage/updated", {
            threadId: options.threadId,
            turnId,
            tokenUsage: {
              total: usage(info.total_token_usage),
              last: usage(info.last_token_usage),
              modelContextWindow:
                typeof info.model_context_window === "number"
                  ? info.model_context_window
                  : null,
            },
          });
        }
        return [];
      }
      if (record.type !== "response_item") return [];
      const deltas: ThreadDelta[] = [];
      const content = Array.isArray(payload.content)
        ? payload.content.map(object)
        : [];
      const text = content
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("\n");
      if (payload.type === "message" && payload.role === "user") {
        deltas.push(...complete(), ...open());
        if (text) deltas.push({ kind: "input.provider", text });
        return deltas;
      }
      deltas.push(...open());
      const id =
        typeof payload.id === "string"
          ? payload.id
          : `import-item-${++ordinal}`;
      if (payload.type === "message" && payload.role === "assistant") {
        deltas.push(...item({ type: "agentMessage", id, text }));
      } else if (payload.type === "reasoning") {
        const summary = Array.isArray(payload.summary)
          ? payload.summary.map(object).map((part) => String(part.text ?? ""))
          : [];
        deltas.push(...item({ type: "reasoning", id, summary, content: [] }));
      } else if (payload.type === "web_search_call") {
        const action = object(payload.action);
        const normalized =
          action.type === "search"
            ? {
                ...action,
                query: action.query ?? null,
                queries: action.queries ?? null,
              }
            : action.type === "open_page"
              ? { type: "openPage", url: action.url ?? null }
              : action.type === "find_in_page"
                ? {
                    type: "findInPage",
                    url: action.url ?? null,
                    pattern: action.pattern ?? null,
                  }
                : action;
        deltas.push(
          ...item({
            type: "webSearch",
            id,
            query: typeof action.query === "string" ? action.query : "",
            action: normalized,
          }),
        );
      } else if (
        payload.type === "function_call" ||
        payload.type === "custom_tool_call"
      ) {
        const callId = String(payload.call_id ?? id);
        calls.set(callId, {
          name: String(payload.name),
          arguments: String(payload.arguments ?? payload.input ?? "{}"),
        });
        let args: Record<string, unknown> = {};
        try {
          args = object(
            JSON.parse(String(payload.arguments ?? payload.input ?? "{}")),
          );
        } catch {
          /* Keep raw arguments below. */
        }
        if (["exec_command", "Bash", "bash"].includes(String(payload.name))) {
          deltas.push(
            ...notify("item/started", {
              threadId: options.threadId,
              turnId,
              item: {
                type: "commandExecution",
                id: callId,
                command: String(args.cmd ?? args.command ?? payload.arguments),
                cwd: String(args.workdir ?? cwd),
                processId: null,
                status: "inProgress",
                commandActions: [],
                aggregatedOutput: null,
                exitCode: null,
                durationMs: null,
              },
            }),
          );
        } else {
          deltas.push({
            kind: "item.open",
            key: { providerItemId: callId },
            item: {
              type: "tool",
              tool: String(payload.name),
              args: payload.arguments ?? payload.input,
            },
          });
        }
        deltas.push(
          ...notify("rawResponseItem/completed", {
            threadId: options.threadId,
            turnId,
            item: payload,
          }),
        );
      } else if (
        payload.type === "function_call_output" ||
        payload.type === "custom_tool_call_output"
      ) {
        const callId = String(payload.call_id ?? id);
        const call = calls.get(callId);
        if (call) {
          let args: Record<string, unknown> = {};
          try {
            args = object(JSON.parse(call.arguments));
          } catch {
            /* Preserve malformed tool arguments as text. */
          }
          const output =
            typeof payload.output === "string"
              ? payload.output
              : JSON.stringify(payload.output);
          if (["exec_command", "Bash", "bash"].includes(call.name)) {
            deltas.push(
              ...item({
                type: "commandExecution",
                id: callId,
                command: String(args.cmd ?? args.command ?? call.arguments),
                cwd: String(args.workdir ?? cwd),
                processId: null,
                status: "completed",
                commandActions: [],
                aggregatedOutput: output,
                exitCode: null,
                durationMs: null,
              }),
            );
          } else {
            deltas.push({
              kind: "item.close",
              key: { providerItemId: callId },
              item: {
                type: "tool",
                tool: call.name,
                args: call.arguments,
                result: output,
              },
              status: "completed",
            });
          }
          calls.delete(callId);
        }
      }
      return deltas;
    },
    settle: () => complete(),
  };
}
