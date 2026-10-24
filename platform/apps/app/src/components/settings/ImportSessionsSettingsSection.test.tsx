// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImportSessionsSettingsSection } from "./ImportSessionsSettingsSection";

const request = vi.hoisted(() => vi.fn());
vi.mock("@/lib/app-surface", () => ({ fetchWithAppSurface: request }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("discovers sessions, imports them, and refreshes the thread list", async () => {
  let finishImport: ((response: Response) => void) | undefined;
  request.mockImplementation((path: string) => {
    if (path.endsWith("/sources"))
      return Promise.resolve(
        Response.json({
          sources: [
            {
              source: "claude-code",
              root: "/home/owner/.claude/projects",
              count: 9,
            },
          ],
        }),
      );
    return new Promise<Response>((resolve) => {
      finishImport = resolve;
    });
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <ImportSessionsSettingsSection />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("9 sessions")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  expect(await screen.findByText(/Importing session history/)).toBeTruthy();
  await waitFor(() => expect(finishImport).toBeDefined());
  finishImport!(
    Response.json({ imported: 9, updated: 0, records: 42, errors: [] }),
  );
  expect(
    await screen.findByText(
      "Imported 9 sessions, updated 0 sessions and added 42 records.",
    ),
  ).toBeTruthy();
  expect(request).toHaveBeenCalledWith(
    "/api/v1/threads/import",
    expect.objectContaining({ method: "POST", body: "{}" }),
  );
  expect(invalidate).toHaveBeenCalled();
});
