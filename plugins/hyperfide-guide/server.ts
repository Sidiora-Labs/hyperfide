import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import { introduction } from "./introduction.js";

export default async function plugin(hyperfide: HyperfidePluginApi) {
  const settings = hyperfide.settings.define({
    introduction: {
      type: "boolean",
      label: "Send HYPERFIDE introduction",
      description:
        "Tell agents about the HYPERFIDE CLI, threads, and clickable links. Applies to new agent sessions.",
      default: true,
    },
    skills: {
      type: "boolean",
      label: "Enable bundled skills",
      description: "Make the selected HYPERFIDE guide skills available to agents.",
      default: true,
    },
    hyperfideCli: {
      type: "boolean",
      label: "HYPERFIDE CLI skill",
      description: "Inspect and manage HYPERFIDE through the CLI.",
      default: true,
    },
    pluginAuthoring: {
      type: "boolean",
      label: "Plugin authoring skill",
      description: "Create and change HYPERFIDE plugins and SDK extensions.",
      default: true,
    },
    skillCreator: {
      type: "boolean",
      label: "Skill creator skill",
      description: "Create and improve HYPERFIDE skills.",
      default: true,
    },
    submitPlugin: {
      type: "boolean",
      label: "Plugin submission skill",
      description:
        "Prepare and submit a HYPERFIDE plugin to the Community marketplace.",
      default: true,
    },
  });
  let current = await settings.get();
  settings.onChange((next) => {
    current = next;
  });
  hyperfide.agents.contributeInstructions(() =>
    current.introduction ? introduction : null,
  );
  hyperfide.agents.configure(() => ({
    tools: [],
    skills: current.skills
      ? [
          ...(current.hyperfideCli ? ["hyperfide-cli"] : []),
          ...(current.pluginAuthoring ? ["hyperfide-plugin-authoring"] : []),
          ...(current.skillCreator ? ["skill-creator"] : []),
          ...(current.submitPlugin ? ["submit-a-plugin"] : []),
        ]
      : [],
  }));
}
