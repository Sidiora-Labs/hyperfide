import { expect, it } from "vitest";
import { resolveWorkerMcp } from "./worker-mcp.js";
import {
  threadIdentityResultSchema,
  threadStartParamsSchema,
} from "./requests.js";

it("passes thread context to the MCP hook and validates attached capabilities", () => {
  const context = {
    cwd: "/repository",
    threadId: "thread",
    task: "hyperfide-v22/1.4",
  };
  const capability = {
    id: "hyperfide-worker",
    label: "Hyperfide graph worker",
    instructions: "survey then context; cite file and line",
    mcpServers: {
      codify: {
        command: "hyperfide",
        args: ["mcp"],
        env: { CG_TASK: context.task },
      },
    },
  };
  expect(
    resolveWorkerMcp(context, (received) => {
      expect(received).toEqual(context);
      return capability;
    }),
  ).toEqual(capability);
  expect(resolveWorkerMcp(context, () => null)).toBeNull();
  expect(
    threadIdentityResultSchema.parse({
      providerThreadId: "provider-thread",
      attachedCapabilities: [capability],
    }).attachedCapabilities,
  ).toEqual([capability]);
  expect(threadStartParamsSchema.shape.task.parse(context.task)).toBe(
    context.task,
  );
  expect(() =>
    resolveWorkerMcp(context, () => ({ ...capability, instructions: "" })),
  ).toThrow();
});
