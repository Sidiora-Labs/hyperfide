import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { Ask, AskBridge } from "../../hyperfide-asks/client.js";
import {
  interactionResponseSchema,
  type InteractionPayload,
  type InteractionQuestion,
  type InteractionResponse,
} from "./contracts.js";

const executeFile = promisify(execFile);
export type AskCommand = (
  repository: string,
  argv: string[],
) => Promise<string>;
export const runAskCommand: AskCommand = async (repository, argv) => {
  const { stdout } = await executeFile(
    process.env.HYPERFIDE_BINARY ?? "hyperfide",
    argv,
    {
      cwd: repository,
      maxBuffer: 1024 * 1024,
    },
  );
  return stdout;
};

type InputResult =
  | { outcome: "submitted"; value: unknown }
  | { outcome: "cancelled"; reason: string };

export interface QuestionMapping {
  requestId: string;
  repository: string;
  task: string;
  threadId: string;
  asks: Record<string, string>;
}

function inboxAnswer(ask: Ask, question: InteractionQuestion) {
  if (ask.note) {
    try {
      const saved = interactionResponseSchema.shape.answers.valueType.safeParse(
        JSON.parse(ask.note),
      );
      if (saved.success) return saved.data;
    } catch {
      /* An operator's plain note is not a structured thread answer. */
    }
  }
  const option = question.options.find((entry) => entry.label === ask.answer);
  return option
    ? { selected: [option.value], ...(ask.note ? { freeText: ask.note } : {}) }
    : { selected: [], freeText: ask.note || ask.answer || "" };
}

export async function askWithInbox(args: {
  bridge: AskBridge;
  command?: AskCommand;
  payload: InteractionPayload;
  threadId: string;
  projectId: string;
  signal: AbortSignal;
  pollMs?: number;
  recommendations?: Record<string, string>;
  save(mapping: QuestionMapping): Promise<void>;
  display(requestId: string, signal: AbortSignal): Promise<InputResult>;
  submit(requestId: string, value: InteractionResponse): Promise<boolean>;
}): Promise<InputResult> {
  const command = args.command ?? runAskCommand;
  args.signal.throwIfAborted();
  for (const question of args.payload.questions) {
    const recommendation = args.recommendations?.[question.id];
    if (
      !recommendation ||
      !question.options.some((option) => option.label === recommendation)
    ) {
      throw new Error(`Question ${question.id} requires a recommended option`);
    }
  }
  const context = await args.bridge.context(args.threadId, args.projectId);
  if (!context.repository || !context.task)
    throw new Error("Question requires a repository and task");
  const mapping: QuestionMapping = {
    ...context,
    requestId: randomUUID(),
    threadId: args.threadId,
    asks: {},
  };
  for (const question of args.payload.questions) {
    const options = question.options.map((option) => option.label);
    args.signal.throwIfAborted();
    const recommendation = args.recommendations![question.id]!;
    const stdout = await command(context.repository, [
      "ask",
      "raise",
      "question",
      question.prompt,
      ...options.flatMap((option) => ["--option", option]),
      "--option",
      "Other",
      "--recommend",
      recommendation,
      "--task",
      context.task,
      "--session",
      args.threadId,
      "--json",
    ]);
    const raised = JSON.parse(stdout) as { id: string | number };
    if (!raised.id) throw new Error("Ask raise returned no id");
    mapping.asks[question.id] = String(raised.id);
    await args.save(mapping);
  }

  const controller = new AbortController();
  const signal = AbortSignal.any([args.signal, controller.signal]);
  const displayed = args.display(mapping.requestId, signal);
  const watch = (async () => {
    while (!signal.aborted) {
      const response: InteractionResponse = { answers: {} };
      for (const question of args.payload.questions) {
        const ask = await args.bridge.get(
          context.repository,
          mapping.asks[question.id]!,
        );
        if (ask.status !== "answered" || ask.answer == null) continue;
        response.answers[question.id] = inboxAnswer(ask, question);
      }
      if (
        Object.keys(response.answers).length === args.payload.questions.length
      ) {
        if (await args.submit(mapping.requestId, response)) return;
      }
      await delay(args.pollMs ?? 1000, undefined, { signal }).catch((error) => {
        if (!signal.aborted) throw error;
      });
    }
  })();
  try {
    // A watch failure must reach the tool caller, not become an unhandled rejection.
    const result = await Promise.race([displayed, watch.then(() => displayed)]);
    if (result.outcome === "submitted") {
      const response = interactionResponseSchema.parse(result.value);
      for (const question of args.payload.questions) {
        const answer = response.answers[question.id];
        if (!answer || (answer.selected.length === 0 && !answer.freeText))
          continue;
        const selected = question.options.filter((option) =>
          answer.selected.includes(option.value),
        );
        const primary = selected[0]?.label ?? "Other";
        try {
          await command(context.repository, [
            "ask",
            "answer",
            mapping.asks[question.id]!,
            primary,
            "-m",
            JSON.stringify(answer),
          ]);
        } catch (error) {
          const failure = error as { code?: number; stderr?: string };
          if (
            failure.code !== 1 ||
            !failure.stderr?.includes("already answered")
          )
            throw error;
          const settled = await args.bridge.get(
            context.repository,
            mapping.asks[question.id]!,
          );
          response.answers[question.id] = inboxAnswer(settled, question);
        }
      }
      return { outcome: "submitted", value: response };
    }
    return result;
  } finally {
    controller.abort();
    await Promise.allSettled([watch, displayed]);
  }
}
