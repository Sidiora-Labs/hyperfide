import type { Command } from "commander";
import { createSpecCli } from "../../../../plugins/hyperfide-spec/src/cli/index.mjs";

export function registerSpecCommands(program: Command): void {
  const cli = createSpecCli();
  program.command("spec")
    .description(cli.summary)
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (_options, command: Command) => {
      const result = await cli.run(command.args, { cwd: process.cwd() });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exitCode = result.exitCode;
    });
}
