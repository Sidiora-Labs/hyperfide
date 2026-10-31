import { describe, expect, it } from "vitest";
import { parseAutomationDueMessage } from "../src/timeline/automation-due-message.js";

describe("parseAutomationDueMessage", () => {
  it("returns the automation id and the prompt offset after the marker", () => {
    const text =
      "[hyperfide automation due:auto_zto0dtbcxme]\n\nWeekday unread digest.";
    const parsed = parseAutomationDueMessage(text);
    expect(parsed?.automationId).toBe("auto_zto0dtbcxme");
    expect(text.slice(parsed?.bodyOffset ?? 0)).toBe("Weekday unread digest.");
  });

  it("ignores text that only mentions the marker later on", () => {
    expect(
      parseAutomationDueMessage("See [hyperfide automation due:auto_1] for details"),
    ).toBeNull();
  });

  it("ignores other hyperfide prefixes and malformed markers", () => {
    expect(parseAutomationDueMessage("[hyperfide system]\n\nhello")).toBeNull();
    expect(
      parseAutomationDueMessage("[hyperfide automation due:]\n\nhello"),
    ).toBeNull();
    expect(parseAutomationDueMessage("[hyperfide automation due:auto_1")).toBeNull();
  });
});
