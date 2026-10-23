// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createLanguageServerIndexStatus } from "../../hyperfide-graph/language-server-index-projection.js";

it("shows the repository language-server state in an Index panel row", async () => {
  const fetchStatus = vi.fn(async (_url: URL, _options: unknown) => ({
    ok: true,
    json: async () => ({ status: "running" }),
  }));
  vi.stubGlobal("fetch", fetchStatus);
  const row = createLanguageServerIndexStatus("http://localhost:1234", "/repo");
  document.body.append(row.element);
  try {
    await row.refresh();
    expect(row.element.textContent).toBe("Language server: running");
    expect(String(fetchStatus.mock.calls[0]?.[0])).toContain(
      "repository=%2Frepo",
    );
    fetchStatus.mockRejectedValueOnce(new Error("offline"));
    await row.refresh();
    expect(row.element.textContent).toBe("Language server: stopped");
  } finally {
    row.dispose();
    vi.unstubAllGlobals();
  }
  expect(document.querySelector('[role="status"]')).toBeNull();
});
