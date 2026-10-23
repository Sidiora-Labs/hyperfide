import { describe, expect, it } from "vitest";
import { formatHomePathForDisplay } from "@bb/shared-ui/lib/utils";

describe("formatHomePathForDisplay", () => {
  it.each([
    ["/Users/you", "~"],
    ["/Users/you/.hyperfide/plugins/github", "~/.hyperfide/plugins/github"],
    ["/home/u/.hyperfide/skills/review", "~/.hyperfide/skills/review"],
    ["/root/.hyperfide/automations/run.sh", "~/.hyperfide/automations/run.sh"],
    ["C:\\Users\\you\\.hyperfide\\plugins", "~\\.hyperfide\\plugins"],
  ])("compacts a conventional home path %s", (path, expected) => {
    expect(formatHomePathForDisplay(path)).toBe(expected);
  });

  it.each([
    "/managed/plugins/github",
    "/Volumes/work/plugins/github",
    "skills.sh/example/writing-voice",
    "SKILL.md",
  ])("preserves a path outside a conventional home %s", (path) => {
    expect(formatHomePathForDisplay(path)).toBe(path);
  });
});
