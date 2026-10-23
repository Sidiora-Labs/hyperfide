import { describe, expect, it } from "vitest";
import { mcpAccessProblem } from "./access.js";

function problem(headers: Record<string, string>) {
  return mcpAccessProblem(new Headers(headers));
}

describe("mcpAccessProblem", () => {
  it("lets a local caller with no gate headers through", () => {
    expect(problem({})).toBeNull();
  });

  it("refuses a local request that comes from a web page", () => {
    expect(problem({ origin: "https://evil.example" })).toMatchObject({
      status: 403,
    });
    expect(problem({ origin: "http://127.0.0.1:38886" })).toMatchObject({
      status: 403,
    });
  });

  it.each(["session", "machine", "", "OAuth"])(
    "refuses a gate request authenticated as %j",
    (kind) => {
      expect(
        problem({ "x-hyperfide-gate-auth": kind, "x-hyperfide-gate-oauth-scope": "hyperfide" }),
      ).toMatchObject({ status: 403 });
    },
  );

  it("lets a gate request with an OAuth token for hyperfide through", () => {
    expect(
      problem({ "x-hyperfide-gate-auth": "oauth", "x-hyperfide-gate-oauth-scope": "hyperfide" }),
    ).toBeNull();
    expect(
      problem({
        "x-hyperfide-gate-auth": "oauth",
        "x-hyperfide-gate-oauth-scope": "openid hyperfide",
      }),
    ).toBeNull();
  });

  it("refuses an OAuth request without the hyperfide scope", () => {
    for (const scope of ["", "openid", "hyperfide-invalid", "hyperfide:all"]) {
      expect(
        problem({ "x-hyperfide-gate-auth": "oauth", "x-hyperfide-gate-oauth-scope": scope }),
      ).toMatchObject({ status: 403 });
    }
  });
});
