import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { createClaudeDeltaTranslator } from "./delta-translation.js";
import { threadEventSchema } from "../../../lib/domain/src/provider-event.js";
import { createClaudeTranscriptTranslator } from "./transcript-import.js";
import { experimental_createDeltaAssembler as createDeltaAssembler } from "@hyperfide/plugin-sdk/provider-bridge/testing";

describe("Claude host transcript import", () => {
  it("uses the live translator for text, reasoning and tool results", () => {
    const translator = createClaudeTranscriptTranslator({
      cwd: "/workspace",
      threadId: "session",
    });
    const assembler = createDeltaAssembler({
      providerId: "provider-claude-code",
      entropyPrefix: "import-test",
      textDeltaFlushMs: 0,
    });
    const records = [
      {
        type: "user",
        sessionId: "session",
        message: { role: "user", content: "Inspect project" },
      },
      {
        type: "assistant",
        sessionId: "session",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Inspecting" },
            { type: "text", text: "I will inspect it." },
            {
              type: "tool_use",
              id: "read",
              name: "Read",
              input: { file_path: "/workspace/file" },
            },
          ],
        },
      },
      {
        type: "user",
        sessionId: "session",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "read", content: "contents" },
          ],
        },
      },
    ];
    const events = records.flatMap((record) =>
      assembler.assemble({
        threadId: "session",
        deltas: translator.translate(record),
      }),
    );
    events.push(
      ...assembler.assemble({
        threadId: "session",
        deltas: translator.settle(),
      }),
    );
    for (const event of events)
      expect(threadEventSchema.safeParse(event).success).toBe(true);
    expect(events.some((event) => event.type === "turn/started")).toBe(true);
    expect(JSON.stringify(events)).toContain("Inspect project");
    expect(JSON.stringify(events)).toContain("I will inspect it.");
    expect(
      events.some(
        (event) =>
          event.type === "item/completed" &&
          event.item.type === "fileRead" &&
          event.item.status === "completed",
      ),
    ).toBe(true);
  });
  it("translates a sidechain in its own thread without leaking the parent", () => {
    const child = createClaudeTranscriptTranslator({
      cwd: "/workspace",
      threadId: "agent-child",
    });
    expect(
      child.translate({
        type: "user",
        isSidechain: true,
        sessionId: "parent",
        agentId: "child",
        message: { role: "user", content: "Inspect child" },
      }),
    ).toContainEqual({ kind: "input.provider", text: "Inspect child" });
  });
});

const transcripts = new URL("./__fixtures__/transcripts/", import.meta.url);
for (const name of readdirSync(transcripts).filter((name) =>
  [
    "web-search.ndjson",
    "web-fetch-reads.ndjson",
    "plan-mode-question.ndjson",
    "task-output.ndjson",
    "task-plan-model-fallback.ndjson",
    "send-message-edits.ndjson",
  ].includes(name),
)) {
  it(`replays existing ${name} through the live translator without changing its output`, () => {
    const importer = createClaudeTranscriptTranslator({
      cwd: "/workspace",
      threadId: "fixture",
    });
    const live = createClaudeDeltaTranslator({
      cwd: "/workspace",
      sandboxEnabled: false,
    });
    const accepted = importer
      .translate({
        type: "user",
        message: { role: "user", content: "Fixture request" },
      })
      .find((delta) => delta.kind === "input.accepted");
    if (accepted?.kind !== "input.accepted")
      throw new Error("Missing accepted input");
    live.acceptInput("fixture", accepted.clientRequestId);
    const records = readFileSync(new URL(name, transcripts), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    let translated = 0;
    for (const record of records) {
      const actual = importer.translate(record);
      const expected = live.translate(
        { ...record, parent_tool_use_id: record.parent_tool_use_id ?? null },
        { threadId: "fixture" },
      );
      expect(actual).toEqual(expected);
      translated += actual.length;
    }
    expect(translated).toBeGreaterThan(5);
    expect(importer.settle()).toEqual(
      live.buildSessionSettlementDeltas("fixture"),
    );
  });
}
