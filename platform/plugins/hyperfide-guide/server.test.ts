import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@hyperfide/plugin-sdk/testing";
import plugin from "./server.js";

const bundledSkills = readdirSync(new URL("./skills", import.meta.url), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

it("introduces hyperfide without user-question guidance", async () => {
  const { hyperfide, harness } = createFakePluginHost({
    pluginId: "hyperfide-guide",
    agentSkillIds: bundledSkills,
  });
  try {
    await plugin(hyperfide);
    const introduction = harness.registrations.instructionProvider?.({
      threadId: "thr_test",
      projectId: "proj_test",
    });
    expect(introduction).toContain("You are working inside hyperfide");
    expect(introduction).toContain("agentic IDE");
    expect(introduction).toContain(
      "Reference a HYPERFIDE thread as `@thread:thr_abc123`",
    );
    expect(introduction).toContain("Do not construct thread URLs manually");
    expect(introduction).toContain("`hyperfide voice transcribe <path>`");
    expect(introduction).not.toContain(
      "Ask the user a blocking question only when",
    );
    expect(introduction).toBe(introduction?.trim());
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("keeps the introduction and skill switches independent across reloads", async () => {
  const { hyperfide, harness } = createFakePluginHost({
    pluginId: "hyperfide-guide",
    agentSkillIds: bundledSkills,
  });
  try {
    await plugin(hyperfide);
    const instructions = () =>
      harness.registrations.instructionProvider?.({
        threadId: "thr_test",
        projectId: "proj_test",
      });
    const skills = async () =>
      (
        await harness.behavior.resolveAgentConfiguration(
          makePluginAgentConfigurationContext(),
        )
      ).skills;
    expect(instructions()).toContain("You are working inside hyperfide");
    expect((await skills()).sort()).toEqual([...bundledSkills].sort());
    await harness.behavior.setSettings({
      introduction: false,
      pluginAuthoring: false,
    });
    expect(instructions()).toBeNull();
    expect(await skills()).toEqual([
      "hyperfide-cli",
      "skill-creator",
      "submit-a-plugin",
    ]);
    await harness.behavior.setSettings({ skills: false });
    expect(await skills()).toEqual([]);
    await harness.lifecycle.reload(plugin);
    expect(instructions()).toBeNull();
    expect(await skills()).toEqual([]);
    await harness.behavior.setSettings({ introduction: true, skills: true });
    expect(instructions()).toContain("hyperfide-platform status");
    expect(await skills()).toEqual([
      "hyperfide-cli",
      "skill-creator",
      "submit-a-plugin",
    ]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

describe("individual skill selection", () => {
  it.each([
    ["hyperfideCli", ["hyperfide-plugin-authoring", "skill-creator", "submit-a-plugin"]],
    ["pluginAuthoring", ["hyperfide-cli", "skill-creator", "submit-a-plugin"]],
    ["skillCreator", ["hyperfide-cli", "hyperfide-plugin-authoring", "submit-a-plugin"]],
    ["submitPlugin", ["hyperfide-cli", "hyperfide-plugin-authoring", "skill-creator"]],
  ])("disables %s", async (key, expected) => {
    const { hyperfide, harness } = createFakePluginHost({
      pluginId: "hyperfide-guide",
      agentSkillIds: bundledSkills,
    });
    try {
      await plugin(hyperfide);
      await harness.behavior.setSettings({ [key]: false });
      expect(
        (
          await harness.behavior.resolveAgentConfiguration(
            makePluginAgentConfigurationContext(),
          )
        ).skills,
      ).toEqual(expected);
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
