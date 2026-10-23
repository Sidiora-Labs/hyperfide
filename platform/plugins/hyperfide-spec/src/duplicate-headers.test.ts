import { expect, test } from "vitest";
import { assertUniqueTaskHeaders } from "./duplicate-headers";

test("checks every spec independently and tolerates comments", () => {
  expect(() =>
    assertUniqueTaskHeaders([
      { path: "one", text: "[task.1]\n" },
      { path: "two", text: "[task.1]\n[task.1] # duplicate\n" },
    ]),
  ).toThrow("in two");
  expect(() =>
    assertUniqueTaskHeaders([
      { path: "one", text: "[task.1]\n" },
      { path: "two", text: "[task.1]\n" },
    ]),
  ).not.toThrow();
});
