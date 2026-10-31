// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  resetPluginLogoStoreForTest,
  setPluginLogoUrls,
} from "@/lib/plugin-logos";

import { SidebarNavigationIcon } from "@/components/sidebar/SidebarNavigationModel";
import { PluginPanelHeaderCenter } from "./PluginPanelHeader";

const { PluginIcon } = await import("./PluginIcon");

afterEach(() => {
  cleanup();
  resetPluginLogoStoreForTest();
});

it("uses branding.icon instead of the image logo or contribution hint", () => {
  setPluginLogoUrls(
    new Map([
      [
        "docs",
        {
          displayName: "Docs",
          icon: "FileText",
          compactIconUrl: null,
          logoUrl: "/api/v1/plugins/docs/assets/logo?h=abc",
          logoDarkUrl: "/api/v1/plugins/docs/assets/logo-dark?h=def",
          icons: new Map(),
        },
      ],
    ]),
  );

  const view = render(<PluginIcon pluginId="docs" icon="Layers" />);
  expect(view.container.querySelector("[data-icon=FileText]")).toBeTruthy();
  expect(view.container.querySelector("[data-icon=Layers]")).toBeNull();
  expect(view.container.querySelector("img")).toBeNull();
});

it("uses the contribution hint when branding.icon is omitted", () => {
  setPluginLogoUrls(
    new Map([
      [
        "github",
        {
          displayName: "GitHub",
          icon: null,
          compactIconUrl: null,
          logoUrl: "/api/v1/plugins/github/assets/logo?h=abc",
          logoDarkUrl: null,
          icons: new Map(),
        },
      ],
    ]),
  );

  const view = render(<PluginIcon pluginId="github" icon="Layers" />);
  expect(view.container.querySelector("[data-icon=Layers]")).toBeTruthy();
  expect(view.container.querySelector("img")).toBeNull();
});

it("uses Zap compactly when a logo-only plugin has no contribution hint", () => {
  setPluginLogoUrls(
    new Map([
      [
        "github",
        {
          displayName: "GitHub",
          icon: null,
          compactIconUrl: null,
          logoUrl: "/api/v1/plugins/github/assets/logo?h=abc",
          logoDarkUrl: null,
          icons: new Map(),
        },
      ],
    ]),
  );

  const view = render(<PluginIcon pluginId="github" icon={null} />);
  expect(view.container.querySelector("[data-icon=Zap]")).toBeTruthy();
  expect(view.container.querySelector("img")).toBeNull();
});

it("can omit the fallback when plugin branding is unavailable", () => {
  const view = render(
    <PluginIcon pluginId="unavailable" icon={null} fallbackIcon={null} />,
  );
  expect(view.container.querySelector("[data-icon]")).toBeNull();
});

it("uses a plugin-owned compact SVG before named icon hints", () => {
  const compactIconUrl = "/api/v1/plugins/omega/assets/icon?h=abc";
  setPluginLogoUrls(
    new Map([
      [
        "omega",
        {
          displayName: "Omegacode",
          icon: "Workflow",
          compactIconUrl,
          logoUrl: null,
          logoDarkUrl: null,
          icons: new Map(),
        },
      ],
    ]),
  );

  const view = render(<PluginIcon pluginId="omega" icon="Layers" />);
  const asset = view.container.querySelector(
    `[data-plugin-icon-asset="${compactIconUrl}"]`,
  );
  expect(asset).toBeTruthy();
  expect(asset?.getAttribute("style")).toContain(compactIconUrl);
  expect(view.container.querySelector("[data-icon]")).toBeNull();
});

it("resolves every named branding.icon the shipped plugins declare", async () => {
  const { readFile } = await import("node:fs/promises");
  const { execFileSync } = await import("node:child_process");
  const { dirname, join, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { isBuiltinIconName } = await import("@hyperfide/shared-ui/icon");

  const pluginsDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../../plugins",
  );
  const manifests = execFileSync("git", ["ls-files", "-z", "--", "*/package.json"], {
    cwd: pluginsDir,
    encoding: "utf8",
  }).split("\0").filter((name) => name.split("/").length === 2);
  const declared: Array<[string, string]> = [];
  for (const manifestPath of manifests) {
    const manifest: { hyperfide?: { branding?: { icon?: string } } } = JSON.parse(
      await readFile(join(pluginsDir, manifestPath), "utf8"),
    );
    const icon = manifest.hyperfide?.branding?.icon;
    if (icon === undefined || icon.startsWith(".")) continue;
    declared.push([manifestPath.split("/")[0], icon]);
  }

  expect(declared.length).toBeGreaterThan(0);
  expect(declared.filter(([, icon]) => !isBuiltinIconName(icon))).toEqual([]);
});

it.each(["sidebar", "header"])(
  "uses the nav panel icon before branding in its %s",
  (surface) => {
    setPluginLogoUrls(
      new Map([
        [
          "demo",
          {
            displayName: "Demo",
            icon: "Check",
            compactIconUrl: "/demo.svg",
            logoUrl: null,
            logoDarkUrl: null,
            icons: new Map(),
          },
        ],
      ]),
    );
    const view = render(
      surface === "sidebar" ? (
        <SidebarNavigationIcon
          icon={{ kind: "plugin", pluginId: "demo", icon: "Zap" }}
        />
      ) : (
        <PluginPanelHeaderCenter
          chrome={{ pluginId: "demo", icon: "Zap", title: "Inspect" }}
        />
      ),
    );
    expect(view.container.querySelector('[data-icon="Zap"]')).not.toBeNull();
    expect(view.container.querySelector("[data-plugin-icon-asset]")).toBeNull();
  },
);
