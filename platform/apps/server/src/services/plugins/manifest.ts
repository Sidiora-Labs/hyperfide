import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import semver from "semver";
import {
  derivePluginId,
  isCodeThemeFilePath,
  isPluginOwnedIconPath,
  pluginPackageJsonSchema,
  type UiCodeThemeDeclaration,
} from "@hyperfide/domain";
import { resolvePluginCodeThemePath } from "../system/code-themes.js";
import {
  readPluginPackageJsonFile,
  resolveManifestAssetFile,
  resolveManifestEntryFile,
  resolveManifestPath,
  assertValidPluginCompactIconSvg,
  assertValidPluginIconSvg,
} from "@hyperfide/plugin-build";

export interface PluginManifest {
  id: string;
  packageName: string;
  version: string;
  name: string;
  description: string;
  branding: {
    icon?: string;
    compactIconPath?: string;
    logo?: {
      lightPath: string;
      darkPath?: string;
    };
    icons: ReadonlyMap<string, string>;
  };
  hyperfideEngineRange: string | undefined;
  hyperfidePluginSdkRange: string | undefined;
  providerCatalog: Array<{ id: string; displayName: string }>;
  serverEntry: string;
  appEntry: string | undefined;
  hostEntry: string | undefined;
  themes: Array<{
    id: string;
    name: string;
    description: string | null;
    cssPath: string;
    codeTheme: UiCodeThemeDeclaration | null;
    codeThemePaths: { dark?: string; light?: string };
  }>;
  skillsRootPaths: string[];
  skillNames: string[];
  rootDir: string;
}

async function readSkillNames(rootPaths: string[]): Promise<string[]> {
  const names = new Set<string>();
  for (const rootPath of rootPaths) {
    let entries;
    try {
      entries = await readdir(rootPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const skillFile = await lstat(join(rootPath, entry.name, "SKILL.md"));
        if (!skillFile.isFile()) continue;
      } catch {
        continue;
      }
      names.add(entry.name);
    }
  }
  return [...names].sort();
}

export async function readPluginManifest(
  rootDir: string,
): Promise<PluginManifest> {
  const packageJsonPath = join(rootDir, "package.json");
  const json = await readPluginPackageJsonFile(packageJsonPath);
  const parsed = pluginPackageJsonSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") ?? "";
    throw new Error(
      `invalid plugin package.json${path ? ` (${path})` : ""}: ${issue?.message ?? "unknown error"}`,
    );
  }
  const { name: packageName, version, engines, hyperfide } = parsed.data;
  if (
    engines?.hyperfidePluginSdk !== undefined &&
    semver.validRange(engines.hyperfidePluginSdk) === null
  ) {
    throw new Error(
      "invalid plugin package.json (engines.hyperfidePluginSdk): must be a valid semver range",
    );
  }
  const serverEntry = await resolveManifestEntryFile(
    rootDir,
    hyperfide.server,
    "hyperfide.server",
  );
  const hostEntry = hyperfide.host
    ? await resolveManifestEntryFile(rootDir, hyperfide.host, "hyperfide.host")
    : undefined;
  const skillsRootPaths = (hyperfide.skills ?? ["skills"]).map((entry) =>
    resolveManifestPath(rootDir, entry.replace(/\/\*$/, ""), "hyperfide.skills"),
  );
  const resolveBrandingAsset = (entry: string, label: string): string => {
    if (!/\.(svg|png|webp)$/i.test(entry)) {
      throw new Error(
        `manifest ${label} must point at a .svg, .png, or .webp file, got "${entry}"`,
      );
    }
    return resolveManifestPath(rootDir, entry, label);
  };
  const brandingLogo =
    hyperfide.branding.logo === undefined
      ? undefined
      : {
          lightPath: resolveBrandingAsset(
            hyperfide.branding.logo.light,
            "hyperfide.branding.logo.light",
          ),
          ...(hyperfide.branding.logo.dark === undefined
            ? {}
            : {
                darkPath: resolveBrandingAsset(
                  hyperfide.branding.logo.dark,
                  "hyperfide.branding.logo.dark",
                ),
              }),
        };
  const brandingCompactIconPath =
    hyperfide.branding.icon !== undefined && isPluginOwnedIconPath(hyperfide.branding.icon)
      ? resolveBrandingAsset(hyperfide.branding.icon, "hyperfide.branding.icon")
      : undefined;
  for (const [label, assetPath] of [
    ["hyperfide.branding.icon", brandingCompactIconPath],
    ["hyperfide.branding.logo.light", brandingLogo?.lightPath],
    ["hyperfide.branding.logo.dark", brandingLogo?.darkPath],
  ] as const) {
    if (assetPath === undefined) continue;
    const realAsset = await resolveManifestAssetFile(rootDir, assetPath, label);
    if (label === "hyperfide.branding.icon") {
      assertValidPluginCompactIconSvg(await readFile(realAsset), label);
    }
  }
  const brandingIcons = new Map<string, string>();
  for (const [name, entry] of Object.entries(
    hyperfide.branding.experimental_icons ?? {},
  )) {
    const label = `hyperfide.branding.experimental_icons["${name}"]`;
    const realAsset = await resolveManifestAssetFile(
      rootDir,
      resolveManifestPath(rootDir, entry, label),
      label,
    );
    assertValidPluginIconSvg(await readFile(realAsset), label);
    brandingIcons.set(name, realAsset);
  }
  const themeIds = new Set<string>();
  const themes = (hyperfide.themes ?? []).map((theme) => {
    if (themeIds.has(theme.id)) {
      throw new Error(`manifest hyperfide.themes contains duplicate id "${theme.id}"`);
    }
    themeIds.add(theme.id);
    if (!theme.css.toLowerCase().endsWith(".css")) {
      throw new Error(
        `manifest hyperfide.themes theme "${theme.id}" must point at a .css file`,
      );
    }
    const codeTheme = theme.codeTheme ?? null;
    const codeThemePaths: { dark?: string; light?: string } = {};
    if (codeTheme?.dark !== undefined && isCodeThemeFilePath(codeTheme.dark)) {
      codeThemePaths.dark = resolvePluginCodeThemePath(
        rootDir,
        theme.id,
        "dark",
        codeTheme.dark,
      );
    }
    if (
      codeTheme?.light !== undefined &&
      isCodeThemeFilePath(codeTheme.light)
    ) {
      codeThemePaths.light = resolvePluginCodeThemePath(
        rootDir,
        theme.id,
        "light",
        codeTheme.light,
      );
    }
    return {
      id: theme.id,
      name: theme.name,
      description: theme.description ?? null,
      cssPath: resolveManifestPath(rootDir, theme.css, `hyperfide.themes.${theme.id}.css`),
      codeTheme,
      codeThemePaths,
    };
  });
  for (const theme of themes) {
    try {
      await stat(theme.cssPath);
    } catch {
      throw new Error(
        `manifest hyperfide.themes theme "${theme.id}" points at a missing file`,
      );
    }
    for (const [side, path] of Object.entries(theme.codeThemePaths)) {
      try {
        await stat(path);
      } catch {
        throw new Error(
          `manifest hyperfide.themes theme "${theme.id}" codeTheme.${side} points at a missing file`,
        );
      }
    }
  }
  return {
    id: derivePluginId(packageName),
    packageName,
    version,
    name: hyperfide.name,
    description: hyperfide.description,
    branding: {
      ...(hyperfide.branding.icon === undefined ? {} : { icon: hyperfide.branding.icon }),
      ...(brandingCompactIconPath === undefined
        ? {}
        : { compactIconPath: brandingCompactIconPath }),
      ...(brandingLogo === undefined ? {} : { logo: brandingLogo }),
      icons: brandingIcons,
    },
    hyperfideEngineRange: engines?.hyperfide,
    hyperfidePluginSdkRange: engines?.hyperfidePluginSdk,
    providerCatalog: (hyperfide.experimental_providers ?? []).map(
      ({ id, displayName }) => ({ id, displayName }),
    ),
    serverEntry,
    appEntry: hyperfide.app ? resolveManifestPath(rootDir, hyperfide.app, "hyperfide.app") : undefined,
    hostEntry,
    themes,
    skillsRootPaths,
    skillNames: await readSkillNames(skillsRootPaths),
    rootDir,
  };
}
