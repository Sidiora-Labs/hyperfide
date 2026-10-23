import { afterEach, describe, expect, it } from "vitest";
import { runtimeErrorLogFields, summarizeError } from "./error-utils.js";

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
    return;
  }
  process.env.NODE_ENV = originalNodeEnv;
});

describe("error utils", () => {
  it("summarizes Error and non-Error throws", () => {
    expect(summarizeError(new Error("boom"))).toEqual({
      errorMessage: "boom",
      errorName: "Error",
    });
    expect(summarizeError("boom")).toEqual({
      errorMessage: "boom",
      errorName: "NonError",
    });
  });

  it("keeps err outside production and summarizes in production", () => {
    const error = new Error("boom");

    process.env.NODE_ENV = "development";
    expect(runtimeErrorLogFields(error)).toEqual({ err: error });

    process.env.NODE_ENV = "production";
    expect(runtimeErrorLogFields(error)).toEqual({
      errorMessage: "boom",
      errorName: "Error",
    });
  });
});
