import { cliCommand, defineCli } from "@hyperfide/plugin-sdk";
import type { GraphRequest, GraphResult } from "./contract.js";
export function graphCli(run: (request: GraphRequest) => Promise<GraphResult>) {
  return defineCli({
    name: "graph",
    summary: "Inspect the repository graph",
    commands: {
      status: cliCommand({
        summary: "Show binary and index status",
        options: {
          host: { type: "string", required: true, description: "Host id" },
          repository: {
            type: "string",
            required: true,
            description: "Repository path on the host",
          },
        },
        async run(input) {
          return {
            exitCode: 0,
            stdout: JSON.stringify(
              await run({
                hostId: input.options.host,
                repository: input.options.repository,
                command: "index-status",
              }),
            ),
          };
        },
      }),
    },
  });
}
