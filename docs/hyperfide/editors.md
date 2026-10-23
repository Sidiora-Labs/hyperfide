# Editors

The VS Code extension provides the Hyperfide language client and KVX editing
support. Its status bar reports index health. Task management, fleet supervision,
leaders and Asks are available in the platform app.

Set `hyperfide.binaryPath` to the executable on the extension host and
`HYPERFIDE_PLATFORM_URL` to the platform app URL. Use **Hyperfide: Open Current Task
in Platform** or **Hyperfide: Open Current File in Platform** from the command
palette. Links carry the workspace repository path and the current task and
feature, or relative file path and one-based line, as query parameters.

See [the extension README](../../editors/vscode/README.md) for settings and VSIX
build and installation commands.
