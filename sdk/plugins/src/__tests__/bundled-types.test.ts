import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("bundled plugin SDK declarations", () => {
  it("use portable named SDK results without workspace imports", async () => {
    const declarations = await readFile(
      new URL("../../bundled-types/hyperfide-plugin-sdk.d.ts", import.meta.url),
      "utf8",
    );

    expect(declarations).not.toMatch(/from ['"]@hyperfide\//u);
    expect(declarations).not.toContain("PublicApiOutput");
    expect(declarations).not.toContain("PublicApiSchema");
    expect(declarations).toContain("type ThreadSpawnResult = ThreadResponse;");
    expect(declarations).toContain(
      "type FileReadResult = HostFileReadResponse;",
    );
    expect(declarations).toContain("type ProjectGetResult = ProjectResponse;");
    expect(declarations).toContain(
      "type ProjectAttachmentUploadResult = UploadedPromptAttachment;",
    );
    expect(declarations).toContain(
      "upload(args: ProjectAttachmentUploadArgs): Promise<ProjectAttachmentUploadResult>;",
    );
    expect(declarations).toContain(
      "type EnvironmentStatusResult = EnvironmentStatusResponse;",
    );
    expect(declarations).toContain("interface PluginCatalogArea");
    expect(declarations).toContain("catalog: PluginCatalogArea;");
    expect(declarations).toContain("getSource(args: PluginGetSourceArgs)");
    expect(declarations).toContain("checkUpdates(");
    expect(declarations).toContain("applyUpdate(args: PluginIdArgs)");
    expect(declarations).toContain(
      "type PluginProviderNativeRootEntry = ProviderNativeRootInput;",
    );
    expect(declarations).toContain(
      "type PluginProviderNativeRoots = ProviderNativeRootsInputLike;",
    );
    expect(declarations).toContain(
      "One provider-native root as a plugin declares it",
    );
    expect(declarations).toContain(
      "Provider-native roots as a plugin's frozen declaration holds them",
    );

    const appDeclarations = await readFile(
      new URL("../../bundled-types/hyperfide-plugin-sdk-app.d.ts", import.meta.url),
      "utf8",
    );
    expect(appDeclarations).not.toMatch(/from ['"]@hyperfide\//u);
    expect(appDeclarations).toContain("useSdk(): PluginBrowserHyperfideSdk;");
    expect(appDeclarations).toContain("interface ThreadSectionsArea");
    expect(appDeclarations).toContain("threadSections: ThreadSectionsArea;");
    expect(appDeclarations).toContain("interface PluginCatalogArea");
    expect(declarations).toContain(
      "list(args?: ProviderListArgs): Promise<ProviderListResult>;",
    );
    expect(declarations).toContain(
      "models(args?: ProviderModelsArgs): Promise<ProviderModelsResult>;",
    );
    expect(declarations).toContain("interface TerminalsArea");
    expect(declarations).toContain("terminals: TerminalsArea;");
    expect(declarations).toContain(
      "type TerminalListResult = TerminalListResponse;",
    );
    expect(declarations).toContain(
      "rename(args: TerminalRenameArgs): Promise<TerminalRenameResult>;",
    );
    expect(declarations).not.toContain("ThreadTerminalsArea");
    expect(declarations).not.toContain("threads.terminals");
  });

  it("ships portable declarations for every exported subpath", async () => {
    const fileNames = [
      "hyperfide-plugin-sdk.d.ts",
      "hyperfide-plugin-sdk-app.d.ts",
      "hyperfide-plugin-sdk-host.d.ts",
      "hyperfide-plugin-sdk-testing.d.ts",
      "hyperfide-plugin-sdk-testing-app.d.ts",
      "hyperfide-plugin-sdk-testing-host.d.ts",
      "hyperfide-plugin-sdk-environment-provider.d.ts",
    ];
    const declarations = await Promise.all(
      fileNames.map((fileName) =>
        readFile(
          new URL(`../../bundled-types/${fileName}`, import.meta.url),
          "utf8",
        ),
      ),
    );
    for (const content of declarations.slice(0, 3)) {
      expect(content).not.toMatch(/from ['"]@hyperfide\//u);
      expect(content).not.toMatch(/import\(['"]@hyperfide\//u);
    }
    for (const content of declarations.slice(3)) {
      const hyperfideImports = [
        ...content.matchAll(/from ['"](@hyperfide\/[^'"]+)['"]/gu),
      ].map((match) => match[1]);
      expect(new Set(hyperfideImports)).toEqual(new Set(["@hyperfide/plugin-sdk"]));
      expect(content).not.toContain("@hyperfide/sdk");
      expect(content).not.toContain("@hyperfide/server-contract");
    }
    expect(declarations[2]).toContain("interface ExperimentalHostEntry");
    expect(declarations[3]).toContain("interface FakePluginBehaviorDrivers");
    expect(declarations[4]).toContain(
      "interface RenderedSlotLifecycleControls",
    );
    expect(declarations[5]).toContain("interface ExperimentalHostEntryHarness");
    expect(declarations[6]).toContain(
      "interface PluginEnvironmentProviderDefinition",
    );
  });

  it("names the canonical event vocabulary in the provider-bridge testing kit", async () => {
    const testing = await readFile(
      new URL(
        "../../bundled-types/hyperfide-plugin-sdk-provider-bridge-testing.d.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(testing).not.toMatch(/from ['"]@hyperfide\//u);
    expect(testing).not.toMatch(/import\(['"]@hyperfide\//u);
    for (const name of [
      "ThreadEvent",
      "ThreadEventItem",
      "ThreadEventItemPresentation",
      "ThreadEventDelegationItem",
      "ThreadEventExtensionItem",
    ]) {
      expect(testing).toMatch(new RegExp(`(?:type|interface) ${name}\\b`, "u"));
      expect(testing).toMatch(
        new RegExp(`export type \\{[^}]*\\b${name}\\b[^}]*\\}`, "u"),
      );
    }
  });
});
