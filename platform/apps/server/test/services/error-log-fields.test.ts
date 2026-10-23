import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/errors.js";
import {
  isCommandTimeoutError,
  productionErrorLogFields,
  runtimeErrorLogFields,
} from "../../src/services/lib/error-log-fields.js";

describe("error log fields", () => {
  it("summarizes ApiError fields for production logs", () => {
    const error = new ApiError(
      504,
      "command_timeout",
      "Timed out waiting for command result",
      true,
    );

    expect(productionErrorLogFields(error)).toEqual({
      errorCode: "command_timeout",
      errorMessage: "Timed out waiting for command result",
      errorName: "Error",
      errorStatus: 504,
    });
  });

  it("keeps err in development and summarizes in production", () => {
    const error = new Error("boom");

    expect(runtimeErrorLogFields({ isDevelopment: true }, error)).toEqual({
      err: error,
    });
    expect(runtimeErrorLogFields({ isDevelopment: false }, error)).toEqual({
      errorMessage: "boom",
      errorName: "Error",
    });
  });

  it("recognizes only command timeout ApiErrors", () => {
    expect(
      isCommandTimeoutError(
        new ApiError(504, "command_timeout", "Timed out waiting"),
      ),
    ).toBe(true);
    expect(
      isCommandTimeoutError(new ApiError(502, "host_disconnected", "Offline")),
    ).toBe(false);
    expect(isCommandTimeoutError(new Error("command_timeout"))).toBe(false);
  });
});
