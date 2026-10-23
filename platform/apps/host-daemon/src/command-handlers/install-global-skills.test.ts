import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeTempDir } from "@hyperfide/test-helpers";
import { describe, expect, it, vi } from "vitest";
import type { HostDaemonSkillTree } from "@hyperfide/host-daemon-contract";
import {
  installGlobalSkills,
  readGlobalSkillsStatus,
} from "./install-global-skills.js";

const logger = { debug: () => undefined, warn: () => undefined };

function createTreePayload(name: string, body: string): HostDaemonSkillTree {
  const entries = [
    {
      path: "SKILL.md",
      mode: 0o644,
      contentBase64: Buffer.from(
        `---\nname: ${name}\ndescription: Use ${name} outside hyperfide.\n---\n\n${body}\n`,
      ).toString("base64"),
    },
    {
      path: "references/usage.md",
      mode: 0o644,
      contentBase64: Buffer.from(`# ${name}\n`).toString("base64"),
    },
  ].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const hash = createHash("sha256");
  hash.update("hyperfide-skill-tree-v1");
  for (const entry of entries) {
    const bytes = Buffer.from(entry.contentBase64, "base64");
    hash.update("\0file\0");
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.mode.toString(8));
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
  }
  return { treeHash: hash.digest("hex"), entries };
}

describe("install global skills", () => {
  it("writes the skill into both global agent roots", async () => {
    const dataDir = await makeTempDir();
    const homeDir = await makeTempDir();
    const payload = createTreePayload("hyperfide-cli", "first body");

    const result = await installGlobalSkills(
      {
        type: "host.install_global_skills",
        skills: [
          {
            name: "hyperfide-cli",
            treeHash: payload.treeHash,
            entryPath: "SKILL.md",
          },
        ],
      },
      { dataDir, fetchSkillTree: async () => payload, homeDir, logger },
    );

    expect(result.installations.map((entry) => entry.path)).toEqual([
      path.join(homeDir, ".agents", "skills", "hyperfide-cli"),
      path.join(homeDir, ".claude", "skills", "hyperfide-cli"),
    ]);
    for (const installation of result.installations) {
      await expect(
        readFile(path.join(installation.path, "SKILL.md"), "utf8"),
      ).resolves.toContain("first body");
      await expect(
        readFile(
          path.join(installation.path, "references", "usage.md"),
          "utf8",
        ),
      ).resolves.toBe("# hyperfide-cli\n");
    }
  });

  it("replaces a stale copy without leaving its removed files or staging dirs behind", async () => {
    const dataDir = await makeTempDir();
    const homeDir = await makeTempDir();
    const claudeRoot = path.join(homeDir, ".claude", "skills");
    await mkdir(path.join(claudeRoot, "hyperfide-cli"), { recursive: true });
    await writeFile(
      path.join(claudeRoot, "hyperfide-cli", "SKILL.md"),
      "stale\n",
    );
    await writeFile(
      path.join(claudeRoot, "hyperfide-cli", "dropped.md"),
      "gone\n",
    );
    await mkdir(path.join(claudeRoot, "unrelated"), { recursive: true });
    await writeFile(path.join(claudeRoot, "unrelated", "SKILL.md"), "keep\n");
    const payload = createTreePayload("hyperfide-cli", "fresh body");

    await installGlobalSkills(
      {
        type: "host.install_global_skills",
        skills: [
          {
            name: "hyperfide-cli",
            treeHash: payload.treeHash,
            entryPath: "SKILL.md",
          },
        ],
      },
      { dataDir, fetchSkillTree: async () => payload, homeDir, logger },
    );

    await expect(
      readFile(path.join(claudeRoot, "hyperfide-cli", "SKILL.md"), "utf8"),
    ).resolves.toContain("fresh body");
    expect(
      (await readdir(path.join(claudeRoot, "hyperfide-cli"))).sort(),
    ).toEqual(["SKILL.md", "references"]);
    expect((await readdir(claudeRoot)).sort()).toEqual([
      "hyperfide-cli",
      "unrelated",
    ]);
  });

  it("leaves the installed copy intact when the tree cannot be fetched", async () => {
    const dataDir = await makeTempDir();
    const homeDir = await makeTempDir();
    const agentsRoot = path.join(homeDir, ".agents", "skills");
    await mkdir(path.join(agentsRoot, "hyperfide-cli"), { recursive: true });
    await writeFile(
      path.join(agentsRoot, "hyperfide-cli", "SKILL.md"),
      "previous\n",
    );
    const payload = createTreePayload("hyperfide-cli", "never arrives");
    const fetchSkillTree = vi.fn(async () => {
      throw new Error("offline");
    });

    await expect(
      installGlobalSkills(
        {
          type: "host.install_global_skills",
          skills: [
            {
              name: "hyperfide-cli",
              treeHash: payload.treeHash,
              entryPath: "SKILL.md",
            },
          ],
        },
        { dataDir, fetchSkillTree, homeDir, logger },
      ),
    ).rejects.toThrow("offline");

    await expect(
      readFile(path.join(agentsRoot, "hyperfide-cli", "SKILL.md"), "utf8"),
    ).resolves.toBe("previous\n");
  });

  it.skipIf(process.platform === "win32")(
    "reports the installed hash as the tree hash, and detects drift",
    async () => {
      const dataDir = await makeTempDir();
      const homeDir = await makeTempDir();
      const payload = createTreePayload("hyperfide-cli", "installed body");
      const command = {
        type: "host.install_global_skills" as const,
        skills: [
          {
            name: "hyperfide-cli",
            treeHash: payload.treeHash,
            entryPath: "SKILL.md",
          },
        ],
      };
      const statusCommand = {
        type: "host.global_skills_status" as const,
        names: ["hyperfide-cli"],
      };

      const before = await readGlobalSkillsStatus(statusCommand, { homeDir });
      expect(before.entries.map((entry) => entry.treeHash)).toEqual([
        null,
        null,
      ]);

      await installGlobalSkills(command, {
        dataDir,
        fetchSkillTree: async () => payload,
        homeDir,
        logger,
      });

      const after = await readGlobalSkillsStatus(statusCommand, { homeDir });
      expect(after.entries.map((entry) => entry.treeHash)).toEqual([
        payload.treeHash,
        payload.treeHash,
      ]);

      await writeFile(
        path.join(homeDir, ".claude", "skills", "hyperfide-cli", "SKILL.md"),
        "---\nname: hyperfide-cli\ndescription: Edited by hand.\n---\n",
      );
      const drifted = await readGlobalSkillsStatus(statusCommand, { homeDir });
      expect(drifted.entries[1]?.treeHash).not.toBe(payload.treeHash);
      expect(drifted.entries[0]?.treeHash).toBe(payload.treeHash);
    },
  );
});
