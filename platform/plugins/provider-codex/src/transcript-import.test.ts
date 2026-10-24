import { threadEventSchema } from "../../../packages/domain/src/provider-event.js";
import { describe, expect, it } from "vitest";
import { createCodexTranscriptTranslator } from "./transcript-import.js";
import { experimental_createDeltaAssembler as createDeltaAssembler } from "@hyperfide/plugin-sdk/provider-bridge/testing";

describe("Codex rollout import", () => {
  it("reconstructs live turns, user messages, reasoning, tools and assistant messages", () => {
    const translator = createCodexTranscriptTranslator({ threadId: "rollout" });
    const assembler = createDeltaAssembler({
      providerId: "provider-codex",
      entropyPrefix: "import-test",
      textDeltaFlushMs: 0,
    });
    const records = [
      { type: "session_meta", payload: { id: "rollout", cwd: "/workspace" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Inspect rollout" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Thinking" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "shell",
          name: "exec_command",
          arguments: '{"cmd":"pwd"}',
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "shell",
          output: "/workspace",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done inspecting." }],
        },
      },
      { type: "event_msg", payload: { type: "task_complete" } },
    ];
    const events = records.flatMap((record) =>
      assembler.assemble({
        threadId: "rollout",
        deltas: translator.translate(record),
      }),
    );
    for (const event of events)
      expect(threadEventSchema.safeParse(event).success).toBe(true);
    expect(events.some((event) => event.type === "turn/started")).toBe(true);
    expect(JSON.stringify(events)).toContain("Inspect rollout");
    expect(JSON.stringify(events)).toContain("Done inspecting.");
    expect(JSON.stringify(events)).toContain("pwd");
    expect(JSON.stringify(events)).toContain("Thinking");
    expect(translator.settle()).toEqual([]);
  });
});

it("preserves native turn checkpoints, usage and interrupted turns", () => {
  const translator = createCodexTranscriptTranslator({ threadId: "rollout" });
  translator.translate({
    type: "turn_context",
    payload: { cwd: "/workspace", turn_id: "native-turn" },
  });
  translator.translate({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Work" }],
    },
  });
  const usage = translator.translate({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: 20,
          input_tokens: 10,
          output_tokens: 10,
        },
        last_token_usage: {
          total_tokens: 20,
          input_tokens: 10,
          output_tokens: 10,
        },
        model_context_window: 200000,
      },
    },
  });
  expect(usage.some((delta) => delta.kind === "contextWindow")).toBe(true);
  expect(
    translator.translate({
      type: "event_msg",
      payload: { type: "turn_aborted" },
    }),
  ).toContainEqual({
    kind: "turn.boundary",
    status: "interrupted",
    providerCheckpointId: "native-turn",
  });
});

it("imports custom apply_patch tools and native web search calls", () => {
  const translator = createCodexTranscriptTranslator({ threadId: "rollout" });
  const assembler = createDeltaAssembler({
    providerId: "provider-codex",
    entropyPrefix: "custom-test",
    textDeltaFlushMs: 0,
  });
  const patch =
    "*** Begin Patch\n*** Add File: example.txt\n+hello\n*** End Patch";
  const records = [
    {
      type: "custom_tool_call",
      call_id: "patch-call",
      name: "apply_patch",
      input: patch,
    },
    {
      type: "custom_tool_call_output",
      call_id: "patch-call",
      output: "Success. Updated example.txt",
    },
    {
      type: "web_search_call",
      id: "search",
      action: { type: "search", query: "Hyperfide" },
    },
    {
      type: "web_search_call",
      id: "page",
      action: { type: "open_page", url: "https://example.org" },
    },
  ];
  const events = records.flatMap((payload) =>
    assembler.assemble({
      threadId: "rollout",
      deltas: translator.translate({ type: "response_item", payload }),
    }),
  );
  for (const event of events)
    expect(threadEventSchema.safeParse(event).success).toBe(true);
  const started = events.find(
    (event) => event.type === "item/started" && event.item.type === "toolCall",
  );
  const finished = events.find(
    (event) =>
      event.type === "item/completed" && event.item.type === "toolCall",
  );
  expect(started && "item" in started ? started.item.id : undefined).toBe(
    finished && "item" in finished ? finished.item.id : "missing",
  );
  expect(JSON.stringify(events)).toContain("apply_patch");
  expect(JSON.stringify(events)).toContain("example.txt");
  expect(
    events.some(
      (event) =>
        event.type === "item/completed" &&
        event.item.type === "webSearch" &&
        event.item.queries.includes("Hyperfide"),
    ),
  ).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "item/completed" &&
        event.item.type === "webFetch" &&
        event.item.url === "https://example.org",
    ),
  ).toBe(true);
});
