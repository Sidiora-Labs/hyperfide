import { describe, expect, it } from "vitest";
import {
  builtInPaletteCodeThemes,
  DEFAULT_CODE_THEME_DARK,
  DEFAULT_CODE_THEME_LIGHT,
  formatRegisteredCodeThemeName,
  isCodeThemeFilePath,
  parseVscodeThemeJson,
  resolveCodeTheme,
} from "../src/code-theme.js";

describe("code theme resolution", () => {
  it("falls back to Pierre defaults when nothing is declared", () => {
    expect(resolveCodeTheme(null)).toEqual({
      dark: DEFAULT_CODE_THEME_DARK,
      light: DEFAULT_CODE_THEME_LIGHT,
      files: {},
    });
  });

  it("uses a built-in palette's matching Shiki pair", () => {
    const nord = resolveCodeTheme(null, "nord");
    expect(nord.dark).toBe("nord");
    expect(nord.light).toBe("hyperfide:nord:light");
    expect(nord.files["hyperfide:nord:light"]).toMatchObject({
      name: "hyperfide:nord:light",
      type: "light",
      colors: { "editor.background": "#eceff4" },
    });
    expect(resolveCodeTheme(null, "solarized")).toEqual({
      dark: "solarized-dark",
      light: "solarized-light",
      files: {},
    });
  });

  it("gives every built-in palette a distinct light code theme", () => {
    for (const id of Object.keys(builtInPaletteCodeThemes)) {
      const resolved = resolveCodeTheme(null, id);
      expect(resolved.light, id).not.toBe(resolved.dark);
      const shipped = resolved.files[resolved.light];
      if (shipped !== undefined) {
        expect(shipped, id).toMatchObject({
          name: resolved.light,
          type: "light",
        });
      }
    }
    const dracula = resolveCodeTheme(null, "dracula");
    expect(dracula.light).toBe("hyperfide:dracula:light");
    expect(dracula.files["hyperfide:dracula:light"]).toMatchObject({
      type: "light",
      colors: { "editor.background": "#f8f8f2" },
    });
  });

  it("uses the UI theme declaration over the palette fallback", () => {
    expect(
      resolveCodeTheme(
        {
          dark: { name: "hyperfide:ocean:dark", file: { name: "Ocean Dark" } },
          light: { name: "github-light" },
        },
        "nord",
      ),
    ).toEqual({
      dark: "hyperfide:ocean:dark",
      light: "github-light",
      files: { "hyperfide:ocean:dark": { name: "hyperfide:ocean:dark" } },
    });
  });

  it("stamps the registered id onto file JSON so Pierre can resolve it", () => {
    expect(
      resolveCodeTheme({
        dark: {
          name: "hyperfide:ocean:dark",
          file: { name: "Ocean Dark", type: "dark" },
        },
      }).files["hyperfide:ocean:dark"],
    ).toEqual({ name: "hyperfide:ocean:dark", type: "dark" });
  });

  it("treats a .json or path-shaped declaration as a file", () => {
    expect(isCodeThemeFilePath("pierre-dark.json")).toBe(true);
    expect(isCodeThemeFilePath("themes/code-dark.json")).toBe(true);
    expect(isCodeThemeFilePath("github-dark")).toBe(false);
  });

  it("registers custom files under a stable hyperfide: name", () => {
    expect(formatRegisteredCodeThemeName("midnight", "dark")).toBe(
      "hyperfide:midnight:dark",
    );
  });

  it("rejects theme JSON that has no name", () => {
    expect(parseVscodeThemeJson({ type: "dark" })).toBeNull();
    expect(parseVscodeThemeJson({ name: "Ocean Dark", type: "dark" })).toEqual({
      name: "Ocean Dark",
      type: "dark",
    });
  });

  it("rejects deeply nested theme JSON instead of throwing", () => {
    let nested: unknown = { name: "Deep" };
    for (let depth = 0; depth < 64; depth += 1) {
      nested = { child: nested };
    }
    expect(parseVscodeThemeJson(nested)).toBeNull();
  });
});
