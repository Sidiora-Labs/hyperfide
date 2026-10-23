import {
  getPluginMarketplace,
  listPluginMarketplaceIcons,
  markInstalledPluginRemoved,
  upsertInstalledPlugin,
  type DbConnection,
  type PluginSourceIntent,
} from "@hyperfide/db";
import { createMigratedConnection } from "@hyperfide/db/testing";
import {
  CURATED_PLUGIN_MARKETPLACE_NAME,
  ROOT_PLUGIN_SOURCE_SELECTION,
} from "@hyperfide/server-contract";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_CURATED_MARKETPLACE } from "../../../src/services/plugin-catalog/curated-marketplace.js";
import type { MarketplaceFetch } from "../../../src/services/plugin-catalog/marketplace-http.js";
import { createPluginCatalogService } from "../../../src/services/plugin-catalog/plugin-catalog-service.js";
import { listBundledPluginRegistrations } from "../../../src/services/plugins/builtin-registry.js";
import {
  SERVER_MOVE_FROZEN_RETRY_MS,
  setServerMoveFrozen,
} from "../../../src/services/server-move/freeze-state.js";
import { refreshCuratedMarketplace } from "../../helpers/plugin-catalog.js";

const MANIFEST_URL = "https://marketplace.test/marketplace.json";
const ICON_URL = "https://marketplace.test/icons/widgets.svg";
const STATS_URL = "https://marketplace.test/stats.json";
const CUSTOM_V1_MANIFEST_URL =
  "https://marketplace.test/marketplace/v1/marketplace.json";
const SEED_ENTRY_COUNT = BUNDLED_CURATED_MARKETPLACE.plugins.length;
const VALID_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg>',
);

function remoteEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "widgets",
    displayName: "Acme Widgets",
    description: "Widgets for threads.",
    icon: { url: "./icons/widgets.svg" },
    tags: ["interface", "widgets"],
    author: { name: "Acme", github: "acme" },
    source: {
      git: {
        url: "https://github.com/acme/plugins.git",
        subdir: "plugins/widgets",
        ref: "v1.0.0",
      },
    },
    ...overrides,
  };
}

function manifest(plugins: unknown[]): unknown {
  return {
    schemaVersion: 1,
    name: "hyperfide-community",
    displayName: "HYPERFIDE Community",
    plugins,
  };
}

describe("plugin catalog service", () => {
  let db: DbConnection;
  let installedNames: string[];
  let installedCatalogEntries: unknown[];

  let dataDir: string;

  beforeEach(async () => {
    db = createMigratedConnection();
    installedNames = [];
    installedCatalogEntries = [];
    dataDir = await mkdtemp(join(tmpdir(), "hyperfide-catalog-data-"));
  });

  afterEach(async () => {
    db.$client.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  function service(options?: {
    bundledPlugins?: Parameters<
      typeof createPluginCatalogService
    >[0]["bundledPlugins"];
    fetch?: MarketplaceFetch;
    marketplaceUrl?: string;
    warn?: (message: string) => void;
  }) {
    return createPluginCatalogService({
      db,
      appVersion: "1.0.0",
      marketplaceUrl: options?.marketplaceUrl ?? MANIFEST_URL,
      dataDir,
      plugins: {
        installOfficialPlugin: async (name: string) => {
          installedNames.push(name);
          throw new Error("installation stopped by test");
        },
        installCatalogPlugin: async (args: unknown) => {
          installedCatalogEntries.push(args);
          throw new Error("catalog installation stopped by test");
        },
        resolveCatalogNpmSource: async () => ({
          outcome: "unavailable" as const,
          detail: "no registry in this test",
        }),
      },
      ...(options?.bundledPlugins === undefined
        ? {}
        : { bundledPlugins: options.bundledPlugins }),
      ...(options?.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options?.warn === undefined ? {} : { warn: options.warn }),
    });
  }

  function registerInstalledCatalogPlugin(args: {
    pluginId: string;
    name: string;
  }): void {
    upsertInstalledPlugin(db, {
      id: args.pluginId,
      source: `builtin:${args.name}`,
      provenance: {
        kind: "catalog",
        marketplace: "hyperfide-community",
        entryId: args.name,
      },
      sourceIntent: { kind: "builtin", name: args.name },
      exactResolution: { kind: "builtin" },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: null,
      rootDir: `/bundled/${args.name}`,
      version: "0.0.1",
      enabled: true,
      enabledFollowsDefault: false,
    });
  }

  it("starts without a hosted catalog or network calls when no marketplace is configured", async () => {
    const network = vi.fn();
    const catalog = service({ marketplaceUrl: "", fetch: network });
    expect(await catalog.search("")).toEqual([]);
    expect(getPluginMarketplace(db, "hyperfide-official")).toBeUndefined();
    expect(getPluginMarketplace(db, "hyperfide-community")).toBeUndefined();
    expect(network).not.toHaveBeenCalled();
  });

  it("groups a catalog entry by its curated tag", async () => {
    const catalog = service();
    const [hoverCards] = await catalog.search("thread-hover-cards");
    expect(hoverCards).toMatchObject({
      entryId: "thread-hover-cards",
      pluginId: "thread-hover-cards",
      category: "Interface",
      icon: "ZoomIn",
      iconUrl: null,
      source:
        "git:https://github.com/brsbl/hyperfide-plugins.git@30f91fd977ba1ce60532af27a68534464fb62516",
      installed: false,
      compatible: true,
      incompatibleReason: null,
    });
  });

  it("matches queries against entry id, plugin id, manifest text, and tags", async () => {
    const catalog = service();
    expect(
      (await catalog.search("thread-hover-cards")).map(
        (entry) => entry.entryId,
      ),
    ).toContain("thread-hover-cards");
    expect(
      (await catalog.search("thread-hover-cards")).map(
        (entry) => entry.entryId,
      ),
    ).toEqual(["thread-hover-cards"]);
    expect(
      (await catalog.search("sidebar")).map((entry) => entry.entryId),
    ).toContain("thread-hover-cards");
    expect(await catalog.search("no-such-plugin")).toEqual([]);
  });

  it("reflects install and remove in the installed flag", async () => {
    const catalog = service();
    registerInstalledCatalogPlugin({
      pluginId: "thread-hover-cards",
      name: "thread-hover-cards",
    });
    expect((await catalog.search("thread-hover-cards"))[0]?.installed).toBe(
      true,
    );

    markInstalledPluginRemoved(db, "thread-hover-cards");
    expect((await catalog.search("thread-hover-cards"))[0]?.installed).toBe(
      false,
    );
  });

  describe("refresh", () => {
    it("requests a custom configured v1 URL without a v2 rewrite", async () => {
      const requests: string[] = [];
      const catalog = service({
        marketplaceUrl: CUSTOM_V1_MANIFEST_URL,
        fetch: async (url) => {
          requests.push(url);
          return Response.json(manifest([remoteEntry({ icon: "Zap" })]));
        },
      });

      await refreshCuratedMarketplace(catalog, 1_000);
      expect(requests[0]).toBe(CUSTOM_V1_MANIFEST_URL);
      expect(requests).toHaveLength(2);
      expect(await catalog.search("widgets")).toHaveLength(1);
    });

    it("tints a catalog SVG but keeps a raster icon's own colors", async () => {
      const PNG = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
      ]);
      const fetchImpl: MarketplaceFetch = async (url) => {
        if (url === MANIFEST_URL) {
          return Response.json(
            manifest([
              remoteEntry({
                id: "raster",
                icon: { url: "./icons/raster.png" },
              }),
              remoteEntry({ id: "glyph", icon: { url: "./icons/glyph.svg" } }),
            ]),
          );
        }
        return url.endsWith(".png")
          ? new Response(PNG, {
              status: 200,
              headers: { "content-type": "image/png" },
            })
          : new Response(VALID_SVG, {
              status: 200,
              headers: { "content-type": "image/svg+xml" },
            });
      };
      const catalog = service({ fetch: fetchImpl });

      await refreshCuratedMarketplace(catalog, 1_000);
      const tinted = Object.fromEntries(
        (await catalog.search("")).map((entry) => [
          entry.entryId,
          { iconUrl: entry.iconUrl !== null, iconTinted: entry.iconTinted },
        ]),
      );
      expect(tinted).toMatchObject({
        raster: { iconUrl: true, iconTinted: false },
        glyph: { iconUrl: true, iconTinted: true },
      });
    });

    it("replaces the catalog, caches icons, and revalidates with the ETag", async () => {
      const requests: Array<{ url: string; headers: Headers }> = [];
      const fetchImpl: MarketplaceFetch = async (url, init) => {
        requests.push({ url, headers: new Headers(init.headers) });
        if (url === MANIFEST_URL) {
          return requests.filter((request) => request.url === MANIFEST_URL)
            .length === 1
            ? Response.json(manifest([remoteEntry()]), {
                headers: { etag: '"v1"' },
              })
            : new Response(null, { status: 304 });
        }
        return new Response(VALID_SVG, {
          status: 200,
          headers: { "content-type": "image/svg+xml", etag: '"icon-1"' },
        });
      };
      const catalog = service({ fetch: fetchImpl });

      await refreshCuratedMarketplace(catalog, 1_000);
      const results = await catalog.search("widgets");
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        entryId: "widgets",
        displayName: "Acme Widgets",
        category: "Interface",
        icon: null,
        source:
          "git:https://github.com/acme/plugins.git@v1.0.0#plugins/widgets",
      });
      expect(results[0]?.iconUrl).toBe(
        "/api/v1/plugin-catalog/icons/hyperfide-community/widgets?h=" +
          (await catalog.icon("hyperfide-community", "widgets"))?.hash,
      );
      expect(await catalog.icon("hyperfide-community", "widgets")).toMatchObject({
        contentType: "image/svg+xml",
      });
      expect(results[0]?.iconTinted).toBe(true);
      expect((await catalog.search("thread-hover-cards")).length).toBe(0);
      expect(requests[1]?.url).toBe(ICON_URL);

      await refreshCuratedMarketplace(catalog, 2_000);
      const conditional = requests.filter(
        (request) => request.url === MANIFEST_URL,
      )[1];
      expect(conditional?.headers.get("if-none-match")).toBe('"v1"');
      expect((await catalog.search("widgets"))[0]?.displayName).toBe(
        "Acme Widgets",
      );
      expect(
        requests.filter((request) => request.url === ICON_URL),
      ).toHaveLength(1);
      const row = getPluginMarketplace(db, "hyperfide-community");
      expect(row).toMatchObject({
        etag: '"v1"',
        lastSuccessfulRefreshAt: 2_000,
        lastError: null,
      });
    });

    it("keeps the last-known-good catalog when the payload is invalid", async () => {
      const catalog = service({
        fetch: async () =>
          Response.json(manifest([remoteEntry({ id: "Not Valid" })])),
      });
      await expect(refreshCuratedMarketplace(catalog, 5_000)).rejects.toThrow(
        /invalid marketplace manifest/,
      );
      expect((await catalog.search("thread-hover-cards")).length).toBe(1);
      expect(getPluginMarketplace(db, "hyperfide-community")).toMatchObject({
        lastAttemptedRefreshAt: 5_000,
        lastSuccessfulRefreshAt: null,
      });
      expect(getPluginMarketplace(db, "hyperfide-community")?.lastError).toMatch(
        /invalid marketplace manifest/,
      );
    });

    it("keeps the last-known-good catalog when the request fails", async () => {
      const catalog = service({
        fetch: async () => new Response("nope", { status: 503 }),
      });
      await expect(refreshCuratedMarketplace(catalog, 7_000)).rejects.toThrow(
        "HTTP 503",
      );
      expect((await catalog.search("")).length).toBe(SEED_ENTRY_COUNT);
      expect(getPluginMarketplace(db, "hyperfide-community")?.lastError).toContain(
        "HTTP 503",
      );
    });

    it("refuses a manifest published under another marketplace name", async () => {
      const catalog = service({
        fetch: async () =>
          Response.json({
            ...(manifest([remoteEntry()]) as Record<string, unknown>),
            name: "someone-else",
          }),
      });
      await expect(refreshCuratedMarketplace(catalog, 9_000)).rejects.toThrow(
        /someone-else/,
      );
      expect((await catalog.search("widgets")).length).toBe(0);
    });

    it("falls back to the bundled snapshot when the stored catalog is unreadable", async () => {
      service();
      const stored = getPluginMarketplace(db, "hyperfide-community");
      if (stored === undefined) throw new Error("catalog row missing");
      db.$client
        .prepare("UPDATE plugin_marketplaces SET manifest_json = ?")
        .run("{not json");
      const warnings: string[] = [];
      const catalog = service({ warn: (message) => warnings.push(message) });
      expect((await catalog.search("thread-hover-cards")).length).toBe(1);
      expect(warnings.some((warning) => warning.includes("bundled"))).toBe(
        true,
      );
    });

    it("keeps an entry whose icon fails validation and warns", async () => {
      const warnings: string[] = [];
      const catalog = service({
        warn: (message) => warnings.push(message),
        fetch: async (url) =>
          url === MANIFEST_URL
            ? Response.json(manifest([remoteEntry()]))
            : new Response(Buffer.from("<html>not an icon</html>"), {
                status: 200,
              }),
      });
      await refreshCuratedMarketplace(catalog, 1_000);
      const [entry] = await catalog.search("widgets");
      expect(entry).toMatchObject({ entryId: "widgets", iconUrl: null });
      expect(await catalog.icon("hyperfide-community", "widgets")).toBeUndefined();
      expect(warnings.some((warning) => warning.includes("widgets"))).toBe(
        true,
      );
    });

    it("refuses an icon larger than the cap", async () => {
      const warnings: string[] = [];
      const catalog = service({
        warn: (message) => warnings.push(message),
        fetch: async (url) =>
          url === MANIFEST_URL
            ? Response.json(manifest([remoteEntry()]))
            : new Response(Buffer.alloc(300 * 1024, 0x41), { status: 200 }),
      });
      await refreshCuratedMarketplace(catalog, 1_000);
      expect(await catalog.icon("hyperfide-community", "widgets")).toBeUndefined();
      expect(
        warnings.some((warning) => warning.includes("exceeds 262144 bytes")),
      ).toBe(true);
    });

    it("keeps cached icons while retrying a missing one on a 304", async () => {
      let iconRequests = 0;
      let failFirstIcon = true;
      const catalog = service({
        warn: () => {},
        fetch: async (url) => {
          if (url === MANIFEST_URL) {
            return iconRequests === 0
              ? Response.json(
                  manifest([
                    remoteEntry(),
                    remoteEntry({
                      id: "gadgets",
                      icon: { url: "./icons/gadgets.svg" },
                    }),
                  ]),
                  { headers: { etag: '"v1"' } },
                )
              : new Response(null, { status: 304 });
          }
          iconRequests += 1;
          if (url.endsWith("gadgets.svg") && failFirstIcon) {
            failFirstIcon = false;
            return new Response("boom", { status: 500 });
          }
          return new Response(VALID_SVG, { status: 200 });
        },
      });
      await refreshCuratedMarketplace(catalog, 1_000);
      expect(await catalog.icon("hyperfide-community", "widgets")).toBeDefined();
      expect(await catalog.icon("hyperfide-community", "gadgets")).toBeUndefined();

      await refreshCuratedMarketplace(catalog, 2_000);
      expect(await catalog.icon("hyperfide-community", "widgets")).toBeDefined();
      expect(await catalog.icon("hyperfide-community", "gadgets")).toBeDefined();
    });

    it("drops a cached icon the refreshed manifest no longer lists", async () => {
      let listIcon = true;
      const catalog = service({
        fetch: async (url) =>
          url === MANIFEST_URL
            ? Response.json(
                manifest([
                  listIcon ? remoteEntry() : remoteEntry({ icon: "Zap" }),
                ]),
              )
            : new Response(VALID_SVG, { status: 200 }),
      });
      await refreshCuratedMarketplace(catalog, 1_000);
      expect(await catalog.icon("hyperfide-community", "widgets")).toBeDefined();
      listIcon = false;
      await refreshCuratedMarketplace(catalog, 2_000);
      expect(await catalog.icon("hyperfide-community", "widgets")).toBeUndefined();
    });

    it("drops a cached icon when its replacement URL fails", async () => {
      let iconUrl = "./icons/widgets.svg";
      const catalog = service({
        warn: () => {},
        fetch: async (url) => {
          if (url === MANIFEST_URL) {
            return Response.json(
              manifest([remoteEntry({ icon: { url: iconUrl } })]),
            );
          }
          return url.endsWith("widgets.svg")
            ? new Response(VALID_SVG, { status: 200 })
            : new Response("nope", { status: 503 });
        },
      });
      await refreshCuratedMarketplace(catalog, 1_000);
      expect(await catalog.icon("hyperfide-community", "widgets")).toBeDefined();

      iconUrl = "./icons/replacement.svg";
      await refreshCuratedMarketplace(catalog, 2_000);
      expect(await catalog.icon("hyperfide-community", "widgets")).toBeUndefined();
    });

    it("keeps the prior snapshot when an icon-table commit fails", async () => {
      db.$client.exec(`
        CREATE TRIGGER reject_marketplace_icon
        BEFORE INSERT ON plugin_marketplace_icons
        BEGIN
          SELECT RAISE(ABORT, 'icon write failed');
        END;
      `);
      const catalog = service({
        fetch: async (url) =>
          url === MANIFEST_URL
            ? Response.json(manifest([remoteEntry()]))
            : new Response(VALID_SVG, { status: 200 }),
      });

      await expect(refreshCuratedMarketplace(catalog, 3_000)).rejects.toThrow(
        "icon write failed",
      );
      expect(await catalog.search("widgets")).toEqual([]);
      expect(await catalog.search("thread-hover-cards")).toHaveLength(1);
      expect(getPluginMarketplace(db, "hyperfide-community")).toMatchObject({
        lastSuccessfulRefreshAt: null,
        lastAttemptedRefreshAt: 3_000,
        lastError: expect.stringContaining("icon write failed"),
      });
    });
  });

  describe("install counts", () => {
    function statsResponse(
      plugins: Record<string, { installs: number }>,
      generatedAt = "2026-08-21T00:00:00.000Z",
    ): Response {
      return Response.json({ schemaVersion: 1, generatedAt, plugins });
    }

    function fetchWith(
      stats: () => Response,
      entries: unknown[] = [remoteEntry()],
    ): MarketplaceFetch {
      return async (url) => {
        if (url === MANIFEST_URL) return Response.json(manifest(entries));
        if (url === STATS_URL) return stats();
        return new Response(VALID_SVG, {
          status: 200,
          headers: { "content-type": "image/svg+xml" },
        });
      };
    }

    it("reports counts for curated entries", async () => {
      const catalog = service({
        fetch: fetchWith(() =>
          statsResponse({
            widgets: { installs: 4_210 },
          }),
        ),
      });

      await refreshCuratedMarketplace(catalog, 1_000);
      const byId = new Map(
        (await catalog.search("")).map((entry) => [entry.entryId, entry]),
      );
      expect(byId.get("widgets")?.installs).toBe(4_210);
    });

    it("leaves an entry the sidecar does not name uncounted", async () => {
      const catalog = service({
        fetch: fetchWith(() => statsResponse({ other: { installs: 9 } })),
      });

      await refreshCuratedMarketplace(catalog, 1_000);
      expect((await catalog.search("widgets"))[0]?.installs).toBeNull();
    });

    it("re-reads the sidecar when the manifest is unchanged", async () => {
      let manifestReads = 0;
      let installs = 5;
      const catalog = service({
        fetch: async (url) => {
          if (url === MANIFEST_URL) {
            manifestReads += 1;
            return manifestReads === 1
              ? Response.json(manifest([remoteEntry()]), {
                  headers: { etag: '"v1"' },
                })
              : new Response(null, { status: 304 });
          }
          if (url === STATS_URL) {
            return statsResponse({ widgets: { installs } });
          }
          return new Response(VALID_SVG, {
            status: 200,
            headers: { "content-type": "image/svg+xml" },
          });
        },
      });

      await refreshCuratedMarketplace(catalog, 1_000);
      expect((await catalog.search("widgets"))[0]?.installs).toBe(5);
      installs = 40;
      await refreshCuratedMarketplace(catalog, 2_000);
      expect((await catalog.search("widgets"))[0]?.installs).toBe(40);
    });

    it("keeps the stored counts when the sidecar fails, and the refresh still succeeds", async () => {
      const warnings: string[] = [];
      let sidecarBroken = false;
      const catalog = service({
        warn: (message) => warnings.push(message),
        fetch: fetchWith(() =>
          sidecarBroken
            ? new Response("nope", { status: 500 })
            : statsResponse({ widgets: { installs: 7 } }),
        ),
      });

      await refreshCuratedMarketplace(catalog, 1_000);
      sidecarBroken = true;
      await refreshCuratedMarketplace(catalog, 2_000);
      expect((await catalog.search("widgets"))[0]?.installs).toBe(7);
      expect(getPluginMarketplace(db, "hyperfide-community")).toMatchObject({
        lastSuccessfulRefreshAt: 2_000,
        lastError: null,
      });
      expect(warnings.join("\n")).toMatch(/install counts were not refreshed/u);
    });

    it("rejects a malformed sidecar whole rather than counting part of it", async () => {
      const catalog = service({
        fetch: fetchWith(() =>
          Response.json({
            schemaVersion: 1,
            generatedAt: "2026-08-21T00:00:00.000Z",
            plugins: { widgets: { installs: -1 } },
          }),
        ),
      });

      await refreshCuratedMarketplace(catalog, 1_000);
      expect((await catalog.search("widgets"))[0]?.installs).toBeNull();
    });

    it("does not count entries of a third-party marketplace", async () => {
      const thirdPartyManifest =
        "https://acme.test/marketplace/marketplace.json";
      const statsRequests: string[] = [];
      const catalog = service({
        fetch: async (url) => {
          if (url === MANIFEST_URL) return Response.json(manifest([]));
          if (url.endsWith("/stats.json")) {
            statsRequests.push(url);
            return statsResponse({ widgets: { installs: 999 } });
          }
          if (url === thirdPartyManifest) {
            return Response.json({
              schemaVersion: 1,
              name: "acme",
              displayName: "Acme",
              plugins: [remoteEntry({ icon: "ZoomIn" })],
            });
          }
          return new Response(null, { status: 404 });
        },
      });

      await catalog.addMarketplace({
        source: thirdPartyManifest,
        subdirectory: null,
      });
      await catalog.refreshMarketplaces({ attemptedAt: 2_000 });
      expect((await catalog.search("widgets"))[0]?.installs).toBeNull();
      expect(statsRequests).toEqual([STATS_URL]);
    });
  });

  describe("catalog installs", () => {
    async function refreshedCatalog(entry: Record<string, unknown>) {
      const catalog = service({
        fetch: async (url) =>
          url === MANIFEST_URL
            ? Response.json(manifest([entry]))
            : new Response(VALID_SVG, { status: 200 }),
      });
      await refreshCuratedMarketplace(catalog, 1_000);
      return catalog;
    }

    it("routes a subdirectory entry through the install pipeline", async () => {
      const catalog = await refreshedCatalog(remoteEntry());
      await expect(catalog.install({ entryId: "widgets" })).rejects.toThrow(
        "catalog installation stopped by test",
      );
      expect(installedCatalogEntries).toEqual([
        {
          marketplace: "hyperfide-community",
          entryId: "widgets",
          pluginId: "widgets",
          source: "git:https://github.com/acme/plugins.git@v1.0.0",
          selection: { kind: "subdirectory", path: "plugins/widgets" },
        },
      ]);
      expect(installedNames).toEqual([]);
    });

    it("routes an npm entry with its dist-tag and registry", async () => {
      const catalog = await refreshedCatalog(
        remoteEntry({
          icon: "Zap",
          source: {
            npm: {
              package: "hyperfide-plugin-widgets",
              tag: "beta",
              registry: "https://npm.acme.test",
            },
          },
        }),
      );
      await expect(catalog.install({ entryId: "widgets" })).rejects.toThrow(
        "catalog installation stopped by test",
      );
      expect(installedCatalogEntries).toEqual([
        {
          marketplace: "hyperfide-community",
          entryId: "widgets",
          pluginId: "widgets",
          source: "npm:hyperfide-plugin-widgets@beta",
          selection: ROOT_PLUGIN_SOURCE_SELECTION,
          npmRegistry: "https://npm.acme.test",
        },
      ]);
    });

    it("offers a marketplace entry without judging compatibility", async () => {
      const catalog = await refreshedCatalog(remoteEntry({ icon: "Zap" }));
      const [entry] = await catalog.search("widgets");
      expect(entry).toMatchObject({
        compatible: true,
        incompatibleReason: null,
      });
      const plan = await catalog.installPlan({ entryId: "widgets" });
      expect(plan).toMatchObject({
        compatible: true,
        incompatibleReason: null,
      });
      await expect(catalog.install({ entryId: "widgets" })).rejects.toThrow(
        "catalog installation stopped by test",
      );
    });

    it("reads the installed flag from catalog provenance", async () => {
      const catalog = service();
      upsertInstalledPlugin(db, {
        id: "hover-cards",
        source:
          "git:https://github.com/brsbl/hyperfide-plugins.git@30f91fd977ba1ce60532af27a68534464fb62516",
        provenance: {
          kind: "catalog",
          marketplace: "hyperfide-community",
          entryId: "thread-hover-cards",
        },
        sourceIntent: {
          kind: "git",
          url: "https://github.com/brsbl/hyperfide-plugins.git",
          subdirectory: null,
          selector: {
            kind: "ref",
            ref: "30f91fd977ba1ce60532af27a68534464fb62516",
            refKind: "commit",
          },
        },
        exactResolution: {
          kind: "git",
          commit: "30f91fd977ba1ce60532af27a68534464fb62516",
        },
        updateState: {
          lastCheckAt: null,
          availableCompatibleVersion: null,
          newestIncompatibleVersion: null,
          statusDetail: null,
        },
        activeArtifactId: null,
        rootDir: "/managed/thread-hover-cards",
        version: "0.1.0",
        enabled: true,
        enabledFollowsDefault: false,
      });
      expect((await catalog.search("thread-hover-cards"))[0]?.installed).toBe(
        true,
      );
    });

    it.each([
      {
        name: "a local checkout",
        source: "path:/Users/me/git/thread-hover-cards",
        sourceIntent: {
          kind: "path",
          canonicalPath: "/Users/me/git/thread-hover-cards",
        },
        installed: false,
      },
      {
        name: "a different git repository",
        source: "git:https://github.com/someone-else/hover-cards.git@main",
        sourceIntent: {
          kind: "git",
          url: "https://github.com/someone-else/hover-cards.git",
          subdirectory: null,
          selector: { kind: "ref", ref: "main", refKind: "branch" },
        },
        installed: false,
      },
      {
        name: "the entry's git repository",
        source: "git:https://github.com/brsbl/hyperfide-plugins@main",
        sourceIntent: {
          kind: "git",
          url: "https://github.com/brsbl/hyperfide-plugins",
          subdirectory: null,
          selector: { kind: "ref", ref: "main", refKind: "branch" },
        },
        installed: true,
      },
    ] satisfies {
      name: string;
      source: string;
      sourceIntent: PluginSourceIntent;
      installed: boolean;
    }[])(
      "reports a direct install from $name with the same id as installed: $installed",
      async ({ source, sourceIntent, installed }) => {
        const catalog = service();
        upsertInstalledPlugin(db, {
          id: "thread-hover-cards",
          source,
          provenance: { kind: "direct" },
          sourceIntent,
          exactResolution:
            sourceIntent.kind === "git"
              ? { kind: "git", commit: "0".repeat(40) }
              : { kind: "path" },
          updateState: {
            lastCheckAt: null,
            availableCompatibleVersion: null,
            newestIncompatibleVersion: null,
            statusDetail: null,
          },
          activeArtifactId: null,
          rootDir: "/Users/me/git/thread-hover-cards",
          version: "0.1.0",
          enabled: true,
          enabledFollowsDefault: false,
        });
        expect((await catalog.search("thread-hover-cards"))[0]).toMatchObject({
          installed,
          conflictingInstallSource: installed ? null : source,
        });
      },
    );
  });

  describe("catalog limits and trust", () => {
    it("refreshes and searches a catalog with more than 1024 entries", async () => {
      const largeManifest = manifest(
        Array.from({ length: 1025 }, (_unused, index) =>
          remoteEntry({ id: `widgets-${index}`, icon: "Zap" }),
        ),
      );
      const catalog = service({
        fetch: async () => Response.json(largeManifest),
      });

      await refreshCuratedMarketplace(catalog, 1_000);
      expect(getPluginMarketplace(db, "hyperfide-community")?.lastError).toBeNull();
      expect(await catalog.search("widgets")).toHaveLength(1025);
      expect(await catalog.search("widgets-1024")).toEqual([
        expect.objectContaining({ entryId: "widgets-1024" }),
      ]);
    });

    it("refreshes a remote manifest larger than 1 MiB", async () => {
      const largeManifest = manifest(
        Array.from({ length: 600 }, (_unused, index) =>
          remoteEntry({
            id: `widgets-${index}`,
            icon: "Zap",
            description: "x".repeat(2_000),
          }),
        ),
      );
      expect(JSON.stringify(largeManifest).length).toBeGreaterThan(1_048_576);
      const catalog = service({
        fetch: async () => Response.json(largeManifest),
      });

      await refreshCuratedMarketplace(catalog, 1_000);
      expect(getPluginMarketplace(db, "hyperfide-community")?.lastError).toBeNull();
      expect(await catalog.search("widgets")).toHaveLength(600);
    });

    it("stores catalog icons totaling more than 8 MiB", async () => {
      const bigSvg = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><title>${"a".repeat(200 * 1024)}</title><path d="M0 0h16v16H0z"/></svg>`,
      );
      const entries = Array.from({ length: 64 }, (_unused, index) =>
        remoteEntry({
          id: `widgets-${index}`,
          icon: { url: `./icons/widgets-${index}.svg` },
        }),
      );
      const catalog = service({
        fetch: async (url) =>
          url === MANIFEST_URL
            ? Response.json(manifest(entries))
            : new Response(bigSvg, {
                status: 200,
                headers: { "content-type": "image/svg+xml" },
              }),
      });

      await refreshCuratedMarketplace(catalog, 1_000);
      const icons = listPluginMarketplaceIcons(db, "hyperfide-community");
      expect(icons).toHaveLength(64);
      expect(
        icons.reduce((total, icon) => total + icon.bytes.byteLength, 0),
      ).toBeGreaterThan(8 * 1024 * 1024);
    });

    it("fetches entry icons concurrently", async () => {
      let inFlight = 0;
      let peak = 0;
      const entries = Array.from({ length: 12 }, (_unused, index) =>
        remoteEntry({
          id: `widgets-${index}`,
          icon: { url: `./icons/widgets-${index}.svg` },
        }),
      );
      const catalog = service({
        fetch: async (url) => {
          if (url === MANIFEST_URL) return Response.json(manifest(entries));
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return new Response(VALID_SVG, {
            status: 200,
            headers: { "content-type": "image/svg+xml" },
          });
        },
      });

      await refreshCuratedMarketplace(catalog, 1_000);
      expect(peak).toBeGreaterThan(1);
      expect(await catalog.search("widgets-11")).toHaveLength(1);
    });

    it("drops an icon aimed at a non-public address", async () => {
      const warnings: string[] = [];
      const iconRequests: string[] = [];
      const catalog = service({
        warn: (message) => warnings.push(message),
        fetch: async (url) => {
          if (url === MANIFEST_URL) {
            return Response.json(
              manifest([
                remoteEntry({ icon: { url: "https://127.0.0.1/widgets.svg" } }),
              ]),
            );
          }
          if (url === STATS_URL) return new Response(null, { status: 404 });
          iconRequests.push(url);
          return new Response(VALID_SVG, {
            status: 200,
            headers: { "content-type": "image/svg+xml" },
          });
        },
      });

      await refreshCuratedMarketplace(catalog, 1_000);
      expect(iconRequests).toEqual([]);
      expect(await catalog.icon("hyperfide-community", "widgets")).toBeUndefined();
      expect(warnings.join("\n")).toMatch(/non-public address 127\.0\.0\.1/u);
    });

    it("drops a remote entry that claims a bundled plugin id", async () => {
      const bundled = listBundledPluginRegistrations();
      const occupied = bundled[0];
      if (occupied === undefined) throw new Error("no bundled plugin");
      const catalog = service({
        fetch: async (url) =>
          url === MANIFEST_URL
            ? Response.json(
                manifest([
                  remoteEntry({ id: occupied.pluginId }),
                  remoteEntry({ id: "widgets" }),
                ]),
              )
            : new Response(VALID_SVG, {
                status: 200,
                headers: { "content-type": "image/svg+xml" },
              }),
      });

      await refreshCuratedMarketplace(catalog, 1_000);
      const results = await catalog.search("");
      expect(
        results.filter((entry) => entry.pluginId === occupied.pluginId),
      ).toHaveLength(0);
      expect(results.some((entry) => entry.entryId === "widgets")).toBe(true);
      expect(getPluginMarketplace(db, "hyperfide-community")?.lastError).toMatch(
        new RegExp(`matches a bundled plugin: ${occupied.pluginId}`, "u"),
      );
    });

    it("names the pinned npm registry in the entry source display", async () => {
      const catalog = service({
        fetch: async (url) =>
          url === MANIFEST_URL
            ? Response.json(
                manifest([
                  remoteEntry({
                    icon: "ZoomIn",
                    source: {
                      npm: {
                        package: "hyperfide-plugin-widgets",
                        range: "^1.0.0",
                        registry: "https://npm.acme.test",
                      },
                    },
                  }),
                ]),
              )
            : new Response(null, { status: 404 }),
      });

      await refreshCuratedMarketplace(catalog, 1_000);
      expect((await catalog.search("widgets"))[0]?.source).toBe(
        "npm:hyperfide-plugin-widgets@^1.0.0 (registry https://npm.acme.test)",
      );
    });
  });

  it("disables refresh and scheduling when the marketplace URL is empty", async () => {
    const fetch = vi.fn<MarketplaceFetch>();
    const warn = vi.fn();
    service(); // An existing curated row must also be removed.
    const catalog = service({ marketplaceUrl: "", fetch, warn });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      for (const frozen of [false, true]) {
        setServerMoveFrozen(db, frozen);
        expect(() => catalog.startPeriodicRefresh()).not.toThrow();
        await vi.advanceTimersByTimeAsync(SERVER_MOVE_FROZEN_RETRY_MS);
        expect(await catalog.refreshMarketplaces()).toEqual([]);
        expect(
          await catalog.refreshMarketplaces({
            name: CURATED_PLUGIN_MARKETPLACE_NAME,
          }),
        ).toEqual([]);
        expect(
          getPluginMarketplace(db, CURATED_PLUGIN_MARKETPLACE_NAME),
        ).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
        catalog.stopPeriodicRefresh();
      }
      expect(fetch).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      catalog.stopPeriodicRefresh();
      setServerMoveFrozen(db, false);
      vi.useRealTimers();
    }
  });

  it("defers the periodic marketplace refresh while the server is moving", async () => {
    const fetched: string[] = [];
    const catalog = service({
      fetch: async (url) => {
        fetched.push(String(url));
        return new Response(null, { status: 503 });
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setServerMoveFrozen(db, true);
    try {
      catalog.startPeriodicRefresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetched).toEqual([]);
      expect(vi.getTimerCount()).toBe(1);
      expect(
        getPluginMarketplace(db, CURATED_PLUGIN_MARKETPLACE_NAME)
          ?.lastAttemptedRefreshAt,
      ).toBeNull();

      setServerMoveFrozen(db, false);
      await vi.advanceTimersByTimeAsync(SERVER_MOVE_FROZEN_RETRY_MS);
      await vi.waitFor(() => {
        expect(fetched).not.toEqual([]);
        expect(vi.getTimerCount()).toBe(1);
      });
    } finally {
      catalog.stopPeriodicRefresh();
      setServerMoveFrozen(db, false);
      vi.useRealTimers();
    }
  });
});
