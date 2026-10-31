import type { DiscoveredSkill, SkillRootKind } from "@hyperfide/host-daemon-contract";
import { createHash } from "node:crypto";
import type { SkillProvider } from "@hyperfide/server-contract";
import { describe, expect, it } from "vitest";
import {
  assembleSkillList,
  mapSkillScope,
} from "../../src/services/skills/skill-listing.js";

describe("mapSkillScope", () => {
  const cases: Array<{
    provider: SkillProvider;
    rootKind: SkillRootKind;
    scope: string;
    listedProvider: SkillProvider | null;
    manageable: boolean;
    filePath?: string;
  }> = [
    {
      provider: "claude-code",
      rootKind: "hyperfide-project",
      scope: "hyperfide-project",
      listedProvider: null,
      manageable: true,
    },
    {
      provider: "claude-code",
      rootKind: "hyperfide-data-dir",
      scope: "hyperfide-user",
      listedProvider: null,
      manageable: true,
    },
    {
      provider: "claude-code",
      rootKind: "hyperfide-builtin",
      scope: "hyperfide-builtin",
      listedProvider: null,
      manageable: false,
    },
    {
      provider: "claude-code",
      rootKind: "provider-project",
      scope: "provider-project",
      listedProvider: "claude-code",
      manageable: true,
    },
    {
      provider: "claude-code",
      rootKind: "provider-user",
      scope: "provider-user",
      listedProvider: "claude-code",
      manageable: true,
    },
    {
      provider: "claude-code",
      rootKind: "plugin",
      scope: "plugin",
      listedProvider: "claude-code",
      manageable: false,
    },
    {
      provider: "codex",
      rootKind: "plugin",
      scope: "plugin",
      listedProvider: "codex",
      manageable: false,
    },
  ];

  for (const testCase of cases) {
    it(`maps (${testCase.provider}, ${testCase.rootKind}) → ${testCase.scope}`, () => {
      expect(
        mapSkillScope(
          testCase.provider,
          testCase.rootKind,
          testCase.filePath ?? "/home/user/skills/review/SKILL.md",
        ),
      ).toEqual({
        scope: testCase.scope,
        provider: testCase.listedProvider,
        manageable: testCase.manageable,
      });
    });
  }

  it("keeps bundled Codex system skills protected", () => {
    expect(
      mapSkillScope(
        "codex",
        "provider-user",
        "/home/user/.codex/skills/.system/imagegen/SKILL.md",
      ),
    ).toEqual({ scope: "provider-user", provider: "codex", manageable: false });
  });
});

describe("assembleSkillList", () => {
  function discovered(
    name: string,
    rootKind: SkillRootKind,
    filePath: string,
  ): DiscoveredSkill {
    return {
      id: `skill_${createHash("sha256").update(filePath).digest("hex")}`,
      name,
      description: null,
      rootKind,
      filePath,
      linked: false,
    };
  }

  it("de-dupes a hyperfide skill discovered under both providers", () => {
    const hyperfide = discovered(
      "shared",
      "hyperfide-data-dir",
      "/data/skills/shared/SKILL.md",
    );
    const result = assembleSkillList([
      { provider: "claude-code", skills: [hyperfide] },
      { provider: "codex", skills: [hyperfide] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "shared",
      provider: null,
      scope: "hyperfide-user",
    });
  });

  it("keeps provider-specific skills distinct and sorts by scope then name", () => {
    const result = assembleSkillList([
      {
        provider: "claude-code",
        skills: [
          discovered(
            "zed",
            "provider-user",
            "/home/.claude/skills/zed/SKILL.md",
          ),
          discovered(
            "alpha",
            "hyperfide-project",
            "/cwd/.hyperfide/skills/alpha/SKILL.md",
          ),
        ],
      },
      {
        provider: "codex",
        skills: [
          discovered(
            "zed",
            "provider-user",
            "/home/.codex/skills/zed/SKILL.md",
          ),
        ],
      },
    ]);
    expect(result.map((skill) => [skill.scope, skill.name])).toEqual([
      ["hyperfide-project", "alpha"],
      ["provider-user", "zed"],
      ["provider-user", "zed"],
    ]);
  });

  it("protects a Cursor skill discovered through a symlinked root", () => {
    const cursor = {
      ...discovered(
        "impeccable",
        "provider-project",
        "/cwd/.cursor/skills/impeccable/SKILL.md",
      ),
      linked: true,
    };

    expect(
      assembleSkillList([{ provider: "acp-cursor", skills: [cursor] }]),
    ).toContainEqual(
      expect.objectContaining({
        name: "impeccable",
        scope: "provider-project",
        provider: "acp-cursor",
        manageable: false,
      }),
    );
  });

  it("keeps linked provider user skills visible but not manageable", () => {
    const linked = {
      ...discovered(
        "shared-link",
        "provider-user",
        "/home/.codex/skills/shared-link/SKILL.md",
      ),
      linked: true,
    };

    expect(
      assembleSkillList([{ provider: "codex", skills: [linked] }])[0],
    ).toMatchObject({
      name: "shared-link",
      scope: "provider-user",
      manageable: false,
    });
  });
});
