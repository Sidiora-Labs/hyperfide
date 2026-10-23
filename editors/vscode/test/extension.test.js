const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const cp = require('child_process');
const path = require('path');
const pkg = require('../package.json');
const fs = require('fs');

function harness() {
    const commands = new Map(), links = [], messages = [], subscriptions = [];
    const root = { uri: { fsPath: '/repo' } };
    const status = { show() {}, hide() {}, dispose() {} };
    const uri = { scheme: 'file', fsPath: '/repo/src/a b.ts', toString: () => 'file:///repo/src/a%20b.ts' };
    const editor = { document: { uri }, selection: { active: { line: 8 } } };
    const settings = { HYPERFIDE_PLATFORM_URL: 'https://platform.example/app?workspace=abc', languageServer: false };
    const disposable = () => ({ dispose() {} });
    const vscode = {
        StatusBarAlignment: { Left: 1 }, Uri: { parse: (value) => value },
        env: { openExternal: async (url) => { links.push(url); return true; } },
        commands: { registerCommand(id, fn) { commands.set(id, fn); return disposable(); } },
        languages: new Proxy({ createDiagnosticCollection: disposable }, { get: (obj, key) => obj[key] || disposable }),
        window: { activeTextEditor: editor, createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
            createStatusBarItem: () => status, onDidChangeActiveTextEditor: disposable,
            showErrorMessage: (s) => messages.push(s), showInformationMessage: (s) => messages.push(s) },
        workspace: { workspaceFolders: [root], textDocuments: [], getWorkspaceFolder: () => root,
            getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }),
            onDidSaveTextDocument: disposable },
    };
    const originalLoad = Module._load, originalExec = cp.execFile;
    Module._load = function (name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    let model = { current: { id: '2.5' }, feature: 'v22' };
    cp.execFile = (bin, args, options, callback) => callback(null, JSON.stringify(
        args[0] === 'status' ? { index_health: { state: 'ready' } } : model));
    const entry = path.resolve(__dirname, '../extension.js');
    delete require.cache[entry];
    const extension = require(entry);
    return { commands, links, messages, status, settings, vscode, extension, subscriptions,
        setModel(value) { model = value; },
        restore() { Module._load = originalLoad; cp.execFile = originalExec; } };
}

test('manifest exposes only language support and platform commands', () => {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../kvx.js'), 'utf8'), /fleet\.start/);
    assert.equal(pkg.contributes.views, undefined);
    assert.equal(pkg.contributes.viewsContainers, undefined);
    assert.equal(pkg.contributes.menus, undefined);
    assert.equal(pkg.contributes.languages[0].id, 'kvx');
    assert.equal(pkg.contributes.grammars[0].language, 'kvx');
    assert.deepEqual(pkg.contributes.commands.map((c) => c.command).sort(),
        ['hyperfide.openFileInPlatform', 'hyperfide.openTaskInPlatform']);
});

test('activation registers every command and opens encoded file/task context', async () => {
    const h = harness();
    try {
        await h.extension.activate({ subscriptions: h.subscriptions });
        assert.deepEqual([...h.commands.keys()].sort(), pkg.contributes.commands.map((c) => c.command).sort());
        assert.match(h.status.text, /ready/);
        await h.commands.get('hyperfide.openFileInPlatform')();
        let url = new URL(h.links.pop());
        assert.equal(url.pathname, '/app');
        assert.equal(url.searchParams.get('workspace'), 'abc');
        assert.equal(url.searchParams.get('repository'), '/repo');
        assert.equal(url.searchParams.get('file'), 'src/a b.ts');
        assert.equal(url.searchParams.get('line'), '9');
        await h.commands.get('hyperfide.openTaskInPlatform')();
        url = new URL(h.links.pop());
        assert.equal(url.searchParams.get('task'), '2.5');
        assert.equal(url.searchParams.get('feature'), 'v22');
        h.setModel({});
        await h.commands.get('hyperfide.openTaskInPlatform')();
        h.vscode.window.activeTextEditor = undefined;
        await h.commands.get('hyperfide.openFileInPlatform')();
        h.settings.HYPERFIDE_PLATFORM_URL = '';
        await h.commands.get('hyperfide.openFileInPlatform')();
        assert.equal(h.links.length, 0);
        assert.equal(h.messages.length, 3);
        assert.throws(() => h.extension.platformUrl('command:unsafe', {}), /HTTP/);
        assert.throws(() => h.extension.platformUrl('invalid', {}));
    } finally { h.restore(); }
});
