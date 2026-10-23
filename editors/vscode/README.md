# Hyperfide for VS Code

A language client for `hyperfide lsp`: definitions, references, hover, symbols,
code lenses and diagnostics, with local KVX syntax, completion and navigation.
The status bar shows the active workspace's index health on activation, editor
changes and saves. Errors from the binary appear in the `Hyperfide` output channel.

Workflow operations live in the platform app. The palette offers:

- **Hyperfide: Open Current Task in Platform** opens the active feature's current task.
- **Hyperfide: Open Current File in Platform** opens the current file and line.

Set `HYPERFIDE_PLATFORM_URL` in VS Code settings to your platform app URL.
Links preserve its path and existing query parameters, adding `repository` and
`task`/`feature` or `file`/`line` context. No URL is assumed. With no current task
or file, the command explains what is missing.

| Setting | Default | Purpose |
|---|---|---|
| `hyperfide.binaryPath` | `hyperfide` | Executable on the extension host |
| `hyperfide.languageServer` | `true` | Enable language features from the server |
| `HYPERFIDE_PLATFORM_URL` | empty | Platform app URL |

Install the executable on the extension host (remote host for SSH/containers).
KVX syntax and local editing support work without the server.

The extension is plain JavaScript with no runtime dependencies:

```sh
python3 -I scripts/package-vsix.py
code --install-extension editors/vscode/hyperfide-language-client-2.0.0-dev.vsix --force
npm --prefix editors/vscode test
```

The VSIX name and version come from package.json. The packaging script supports
`--out DIR` and `--check FILE` for reproducible builds and version checks.
