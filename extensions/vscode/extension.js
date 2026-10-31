const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const { LspClient } = require('./client');
const language = require('./language');
const kvx = require('./kvx');

function platformUrl(base, context) {
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP or HTTPS platform URL.');
    for (const [key, value] of Object.entries(context)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
}

async function activate(ctx) {
    const out = vscode.window.createOutputChannel('Hyperfide');
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    const diagnostics = vscode.languages.createDiagnosticCollection('hyperfide');
    const clients = new Map();
    let disposed = false;
    const config = () => vscode.workspace.getConfiguration('hyperfide');
    const rootFor = (uri) => (uri && vscode.workspace.getWorkspaceFolder(uri))
        || vscode.workspace.workspaceFolders?.[0];
    const json = (root, args) => new Promise((resolve) => {
        cp.execFile(config().get('binaryPath', 'hyperfide'), [...args, '--json'],
            { cwd: root.uri.fsPath, timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
                if (err) { out.appendLine(err.message); resolve(null); return; }
                try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
            });
    });
    async function open(kind) {
        const editor = vscode.window.activeTextEditor;
        const root = rootFor(editor?.document.uri);
        const base = vscode.workspace.getConfiguration().get('HYPERFIDE_PLATFORM_URL', '');
        if (!base) return vscode.window.showErrorMessage('Set HYPERFIDE_PLATFORM_URL to your platform app URL.');
        if (!root) return vscode.window.showErrorMessage('Open a workspace first.');
        const context = { repository: root.uri.fsPath };
        if (kind === 'file') {
            if (!editor || editor.document.uri.scheme !== 'file') {
                return vscode.window.showErrorMessage('Open a file first.');
            }
            context.file = path.relative(root.uri.fsPath, editor.document.uri.fsPath);
            context.line = editor.selection.active.line + 1;
        } else {
            const model = await json(root, ['spec', 'status']);
            if (!model?.current?.id) return vscode.window.showInformationMessage('No current Hyperfide task.');
            context.task = model.current.id;
            context.feature = model.feature;
        }
        try { return await vscode.env.openExternal(vscode.Uri.parse(platformUrl(base, context))); }
        catch (err) { return vscode.window.showErrorMessage(`Cannot open platform: ${err.message}`); }
    }
    async function updateIndex() {
        const root = rootFor(vscode.window.activeTextEditor?.document.uri);
        if (!root) { status.hide(); return; }
        const model = await json(root, ['status']);
        if (disposed) return;
        const health = model?.index_health;
        status.text = health ? `$(database) Hyperfide: ${health.state}` : '$(database) Hyperfide: unavailable';
        status.tooltip = health?.reason || 'Hyperfide index status';
        status.show();
    }
    status.command = 'hyperfide.openFileInPlatform';
    ctx.subscriptions.push(out, status, diagnostics,
        { dispose() { disposed = true; for (const client of clients.values()) client.dispose(); } },
        vscode.commands.registerCommand('hyperfide.openTaskInPlatform', () => open('task')),
        vscode.commands.registerCommand('hyperfide.openFileInPlatform', () => open('file')),
        vscode.window.onDidChangeActiveTextEditor(() => updateIndex()),
        vscode.workspace.onDidSaveTextDocument(() => updateIndex()));
    kvx.register(ctx, (args) => {
        const root = rootFor(vscode.window.activeTextEditor?.document.uri);
        return root ? json(root, args) : Promise.resolve(null);
    }, () => rootFor(vscode.window.activeTextEditor?.document.uri)?.uri.fsPath);
    if (config().get('languageServer', true)) {
        for (const root of vscode.workspace.workspaceFolders || []) {
            const client = new LspClient(config().get('binaryPath', 'hyperfide'), root.uri.fsPath,
                (message) => out.appendLine(message));
            clients.set(root.uri.fsPath, client);
            if (await client.start() && !disposed) {
                // Each root gets only its own documents and provider requests.
                const scoped = Object.create(client);
                scoped.tryRequest = (method, params, fallback) => {
                    const uri = params?.textDocument?.uri;
                    if (uri && vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(uri)) !== root) {
                        return Promise.resolve(fallback);
                    }
                    return client.tryRequest(method, params, fallback);
                };
                scoped.notify = (method, params) => {
                    if (vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(params.textDocument.uri)) === root) {
                        client.notify(method, params);
                    }
                };
                scoped.onNotification = client.onNotification.bind(client);
                language.register(ctx, scoped, diagnostics);
            }
        }
    }
    await updateIndex();
}

module.exports = { activate, platformUrl };
