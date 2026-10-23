import { describe, expect, it } from "vitest";
import {
  buildPluginEditThreadPrompt,
  buildSkillEditThreadPrompt,
} from "@hyperfide/shared-ui/resource-edit-prompt";

describe("resource edit thread prompts", () => {
  it("gives the thread an unambiguous writable resource locator", () => {
    expect(
      buildPluginEditThreadPrompt({
        name: "Pattern Atlas",
        path: "/Users/me/plugins/pattern-atlas",
      }),
    ).toBe(
      'Edit the hyperfide-platform plugin "Pattern Atlas" at /Users/me/plugins/pattern-atlas. I want to ',
    );
    expect(
      buildSkillEditThreadPrompt({
        id: "skill_abc123",
        name: "Review PR",
        path: "/Users/me/.hyperfide/skills/review-pr/SKILL.md",
      }),
    ).toBe(
      'Edit the hyperfide skill "Review PR" (ID skill_abc123) at /Users/me/.hyperfide/skills/review-pr/SKILL.md. Inspect it with hyperfide skill show skill_abc123 --json and pass that revision to hyperfide skill update when saving. I want to ',
    );
  });
});
