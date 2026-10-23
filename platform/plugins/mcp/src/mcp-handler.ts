import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { SEARCH_MAX_LIMIT } from "./command-index.js";
import {
  runReadTool,
  runRunTool,
  runSearchTool,
  type ToolDependencies,
  type ToolTextResult,
} from "./tools.js";

const SERVER_INSTRUCTIONS = [
  "hyperfide is an agentic IDE: it runs coding agents (threads) inside projects, on environments and machines the user controls.",
  "This server exposes the whole `hyperfide` command line through three tools.",
  "1. `search` finds hyperfide commands for a task.",
  "2. `read` runs a JavaScript snippet that may only call commands that inspect hyperfide. It never changes anything.",
  "3. `run` runs a JavaScript snippet that may call any hyperfide command, including ones that start agents, send them messages, or change settings. Use it only for what the user asked for.",
  "Snippets call `await hyperfide.cli([...argv])` or `await hyperfide.json([...argv])` and `return` a JSON-serialisable value. Do several steps in one snippet and return only what you need.",
  "A snippet is stopped after 25 seconds. For long waits, return and call again later: `hyperfide-platform thread wait <id> --timeout 15s` reports whether the thread finished.",
].join("\n");

const SCRIPT_API = [
  "The code is the body of an async function: use `await`, and `return` a JSON-serialisable value.",
  "API:",
  "- `hyperfide.cli(argv: string[], options?: { stdin?: string })` resolves to `{ exitCode, stdout, stderr, json? }`. `json` is stdout parsed when the command printed JSON.",
  "- `hyperfide.json(argv: string[], options?)` appends `--json`, returns the parsed output, and throws with hyperfide's error message when the command fails.",
  "- `hyperfide.sleep(ms)` waits, up to 20 seconds.",
  "- `console.log(...)` output is returned after the result.",
  "- At most 4 hyperfide calls run at a time; `Promise.all` over more is fine, the rest wait.",
  "No network, filesystem, timers, or modules. At most 25 seconds, 3 seconds of computation, 64 MB of memory, and 200 hyperfide calls per snippet; output over 60,000 characters is cut, so filter and slice inside the snippet.",
].join("\n");

const codeSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(100_000)
    .describe("JavaScript: the body of an async function."),
});

function toolResult(result: ToolTextResult) {
  return {
    content: [{ type: "text" as const, text: result.text }],
    isError: result.isError,
  };
}

export function createHyperfideMcpServer(
  dependencies: ToolDependencies,
  version: string,
): McpServer {
  const server = new McpServer(
    { name: "hyperfide", version },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "search",
    {
      title: "Find hyperfide commands",
      description:
        "Search the hyperfide command line for commands that do a task. Returns each match's usage, description, options, and whether the `read` tool may call it. Call this before writing a snippet when you do not know the command.",
      inputSchema: z.object({
        query: z
          .string()
          .max(500)
          .describe(
            "What you want to do, in a few words, e.g. 'list running threads' or 'environment diff'. An empty query lists commands alphabetically.",
          ),
        limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit }) =>
      toolResult(await runSearchTool(query, limit, dependencies)),
  );

  server.registerTool(
    "read",
    {
      title: "Inspect hyperfide",
      description: [
        "Run a JavaScript snippet on the hyperfide-platform server that can only inspect hyperfide: list and read threads, projects, environments, diffs, files, terminal output, machines, providers, settings, plugins, skills, and the hyperfide guide. Commands that change anything are refused; use `run` for those.",
        SCRIPT_API,
        "Example: `const threads = await hyperfide.json(['thread', 'list']); return threads.slice(0, 20).map((t) => ({ id: t.id, title: t.title, status: t.status }));`",
      ].join("\n\n"),
      inputSchema: codeSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ code }, context) =>
      toolResult(await runReadTool(code, dependencies, context.mcpReq.signal)),
  );

  server.registerTool(
    "run",
    {
      title: "Control hyperfide",
      description: [
        "Run a JavaScript snippet on the hyperfide-platform server that can call any hyperfide command: start and message agent threads, answer their questions, manage projects, environments, terminals, files, plugins and settings. Agents and terminals run commands and change files on the user's machines, so do only what the user asked for.",
        SCRIPT_API,
        "Example: `const thread = await hyperfide.json(['thread', 'spawn', '--project', projectId, '--prompt-file', '-'], { stdin: 'Fix the failing test in src/app.test.ts' }); return thread;`",
        "Pass long text through `stdin` with the command's `--prompt-file -` or `--message-file -` option. Commands that need an interactive terminal or never exit (`hyperfide terminal attach`, `hyperfide-platform plugin dev`, `hyperfide browser watch`) cannot run here.",
      ].join("\n\n"),
      inputSchema: codeSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ code }, context) =>
      toolResult(await runRunTool(code, dependencies, context.mcpReq.signal)),
  );

  return server;
}

export interface HyperfideMcpHttpHandler {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export function createHyperfideMcpHttpHandler(
  dependencies: ToolDependencies,
  version: string,
  onError: (error: Error) => void,
): HyperfideMcpHttpHandler {
  const handler = createMcpHandler(
    () => createHyperfideMcpServer(dependencies, version),
    { legacy: "stateless", onerror: onError },
  );
  return {
    fetch: (request) => handler.fetch(request),
    close: () => handler.close(),
  };
}
