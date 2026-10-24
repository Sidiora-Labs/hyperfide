import { afterEach, describe, expect, it, vi } from "vitest";
import { importHostSessions } from "./import.js";

afterEach(() => vi.unstubAllGlobals());

describe("host session import", () => {
  it("posts the source selection and preserves the import result", async () => {
    const result = {
      imported: 1,
      updated: 0,
      records: 2,
      sources: [{ source: "codex", root: "/sessions", count: 1 }],
      threads: [
        {
          id: "thr_import",
          title: "Prior work",
          providerId: "provider-codex",
          providerThreadId: "session-1",
        },
      ],
      errors: [],
    };
    const fetch = vi.fn().mockResolvedValue(Response.json(result));
    vi.stubGlobal("fetch", fetch);
    await expect(
      importHostSessions("http://localhost:3100/", {
        source: "codex",
        root: "/sessions",
        dryRun: true,
      }),
    ).resolves.toEqual(result);
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3100/api/v1/threads/import",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "codex",
          root: "/sessions",
          dryRun: true,
        }),
      },
    );
  });

  it("reports failed requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Unavailable", { status: 503 })),
    );
    await expect(
      importHostSessions("http://localhost:3100", {}),
    ).rejects.toThrow("Session import failed (503): Unavailable");
  });
});
