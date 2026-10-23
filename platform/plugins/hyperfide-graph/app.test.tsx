import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { loadPluginApp } from "@hyperfide/plugin-sdk/testing/app";
import { IndexView, SurveyViewer } from "./app.js";
it("registers the Index panel", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  expect(app.navPanels[0]).toMatchObject({
    id: "hyperfide-graph",
    title: "Index",
  });
});
it("shows index and binary freshness and survey output", () => {
  const html = renderToStaticMarkup(
    <IndexView
      result={{
        binary: {
          path: "/cg",
          version: "Hyperfide 22",
          digest: "a".repeat(64),
          ok: true,
        },
        data: {
          status: "ready",
          last_pass: "2026-10-23",
          symbols: 42,
          files: 12,
          stale_anchors: 3,
        },
      }}
    />,
  );
  for (const label of [
    "Hyperfide 22",
    "ready",
    "2026-10-23",
    "42",
    "12",
    "Stale anchors",
    "3",
  ])
    expect(html).toContain(label);
  expect(
    renderToStaticMarkup(
      <SurveyViewer data={{ area: "src", symbols: ["entry"] }} />,
    ),
  ).toContain("entry");
});
