export const RESERVED_HYPERFIDE_CLI_COMMANDS: readonly string[] = [
  "browser",
  "diagnostics",
  "environment",
  "file",
  "guide",
  "help",
  "machine",
  "marketplace",
  "plugin",
  "project",
  "prompt-history",
  "provider",
  "server",
  "settings",
  "skill",
  "status",
  "terminal",
  "theme",
  "thread",
  "updates",
  "voice",
];

export function pluginCliCall(pluginId: string, name: string): string {
  if (RESERVED_HYPERFIDE_CLI_COMMANDS.includes(name))
    return `hyperfide-platform plugin run ${pluginId}`;
  return `hyperfide-platform ${name}`;
}
