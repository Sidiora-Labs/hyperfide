import { expect, it, vi } from "vitest";
import { wavePullRequests } from "./wave-publication";

it("opens a wave pull request through a configured client with the summary", async () => {
  const createPullRequest = vi.fn(async () => ({ url: "fixture:pull/1" }));
  const open = wavePullRequests({ createPullRequest }, "fixture/repo");
  await expect(
    open({
      feature: "fixture",
      wave: 4,
      branch: "publication/fixture/wave-4",
      base: "main",
      summary: "4.4: closure passed",
    }),
  ).resolves.toEqual({ url: "fixture:pull/1" });
  expect(createPullRequest).toHaveBeenCalledExactlyOnceWith({
    repo: "fixture/repo",
    head: "publication/fixture/wave-4",
    base: "main",
    title: "fixture: wave 4",
    body: "4.4: closure passed",
  });
});
