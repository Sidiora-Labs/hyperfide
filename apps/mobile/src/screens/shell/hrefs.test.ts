import { describe, expect, it } from "vitest";
import { firstParam } from "./hrefs";

describe("firstParam", () => {
  it.each([
    [undefined, undefined],
    ["https://bee.hyperfide.example", "https://bee.hyperfide.example"],
    [
      ["https://bee.hyperfide.example", "https://other.example"],
      "https://bee.hyperfide.example",
    ],
  ])("normalizes %j to %j", (value, expected) => {
    expect(firstParam(value)).toBe(expected);
  });
});
