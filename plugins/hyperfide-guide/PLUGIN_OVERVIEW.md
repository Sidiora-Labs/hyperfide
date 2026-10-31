# HYPERFIDE guide

Control the HYPERFIDE introduction and bundled agent skills in Settings → Installed
plugins → HYPERFIDE guide. The plugin and all six settings default to enabled.

- `introduction`: send the HYPERFIDE CLI, thread, and link instructions.
- `skills`: make the selected bundled skills available.
- `hyperfideCli`: include `hyperfide-cli`.
- `pluginAuthoring`: include `hyperfide-plugin-authoring`.
- `skillCreator`: include `skill-creator`.
- `submitPlugin`: include `submit-a-plugin`.

Use `hyperfide platform plugin config hyperfide-guide set <key> true|false` from the CLI, or
`hyperfide platform.sdk.plugins.updateSettings({ pluginId: "hyperfide-guide", values: { ... } })`
through the SDK. Changes apply when agent configuration is next assembled;
they do not erase instructions from an existing conversation.

Disabling the plugin removes its introduction and all four skills. The
settings affect this plugin's copies, not independently installed user or
provider skills. Other plugins keep their own skills. The generated
`plugin-commands` skill continues to describe enabled plugin commands.
