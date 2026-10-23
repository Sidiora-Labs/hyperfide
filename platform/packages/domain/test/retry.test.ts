import { describe, expect, it } from "vitest";
import { calculateExponentialBackoffDelay } from "../src/retry.js";

describe("calculateExponentialBackoffDelay", () => {
  it("uses the base delay for attempts zero and one", () => {
    expect(
      calculateExponentialBackoffDelay({
        attempt: 0,
        baseDelayMs: 250,
        maxDelayMs: 30_000,
      }),
    ).toBe(250);
    expect(
      calculateExponentialBackoffDelay({
        attempt: 1,
        baseDelayMs: 250,
        maxDelayMs: 30_000,
      }),
    ).toBe(250);
  });

  it("doubles the delay until it reaches the cap", () => {
    expect(
      calculateExponentialBackoffDelay({
        attempt: 2,
        baseDelayMs: 250,
        maxDelayMs: 30_000,
      }),
    ).toBe(500);
    expect(
      calculateExponentialBackoffDelay({
        attempt: 3,
        baseDelayMs: 250,
        maxDelayMs: 30_000,
      }),
    ).toBe(1_000);
  });

  it("caps the delay at the configured maximum", () => {
    expect(
      calculateExponentialBackoffDelay({
        attempt: 10,
        baseDelayMs: 1_000,
        maxDelayMs: 30_000,
      }),
    ).toBe(30_000);
  });
});
