import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerSpecCommands } from "../commands/spec.js";

describe("spec command", () => {
  it("registers locally and forwards native flags through Commander", async () => {
    const program = new Command();
    program.exitOverride();
    registerSpecCommands(program);
    await program.parseAsync(["spec", "status", "-f", "missing", "--root", "/tmp"], { from: "user" });
    expect(program.commands[0]?.args).toEqual(["status", "-f", "missing", "--root", "/tmp"]);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});
