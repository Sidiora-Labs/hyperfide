/* Hyperfide sandboxes view — the console.sandboxes read model in the sidebar
 * (hyperfide-v21 6.4, req 5).
 *
 * One row per sandbox the organisation owns, plus one per orphaned provider
 * resource, each with its provider, pool, heartbeat and queue position; under
 * a sandbox, one row per worker slot with its task, slice size and snapshot
 * state. Attach opens the worker's session as a read-only document.
 *
 * The data comes from `hyperfide console sandboxes --json` (task 5.3's verb
 * over the console.sandboxes action). The read model is an observation, never
 * an authority: the view only shows it, with its as_of, and offers no action
 * that places, admits or deletes anything.
 *
 * Like fleet.js, the shaping is pure and vscode-free so a shell can test it
 * (tests/integration/14_vscode.sh, section sandboxes).
 */
let vscode = null;
try { vscode = require('vscode'); } catch (_) { /* headless: model only */ }

const CALL_TIMEOUT_MS = 20000;
const SESSION_SCHEME = 'hyperfide-session';
const COMMAND = ['console', 'sandboxes', '--json'];

/* ---------------- the shaping (pure, no vscode) ---------------- */

function ageText(seconds) {
    if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return 'no heartbeat';
    const s = Math.max(0, Math.round(Number(seconds)));
    return s < 10 ? 'just now' : s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago`
        : s < 172800 ? `${Math.round(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}

/* Slice size is the paths the slice materialised, with the closure's file
 * count when the manifest recorded one. No slice is "no slice", not zero. */
function sliceSize(slice) {
    if (!slice) return { paths: null, closure: null, text: 'no slice' };
    const paths = Number(slice.included_paths);
    const closure = slice.closure_files === null || slice.closure_files === undefined ? null : Number(slice.closure_files);
    const text = `${paths} path${paths === 1 ? '' : 's'}${closure !== null ? ` · closure ${closure} file${closure === 1 ? '' : 's'}` : ''}` +
        (slice.state && slice.state !== 'MATERIALISED' ? ` (${slice.state.toLowerCase()})` : '');
    return { paths, closure, text };
}

/* Queue position: the read model's own field wins wherever it carries one.
 * Otherwise only a PENDING sandbox is queued, and its place is its ordinal
 * among the pending rows in the inventory's own order (creation order). */
function queuePositions(rows) {
    const out = new Map();
    let n = 0;
    (rows || []).forEach((r, i) => {
        if (r && Number.isInteger(r.queue_position)) out.set(i, r.queue_position);
        else if (r && r.liveness === 'PENDING') out.set(i, ++n);
    });
    return out;
}

function workerNode(s, w, i) {
    const a = w.attempt, r = w.runner, snap = w.snapshot || { state: 'NO_ATTEMPT' };
    const slice = sliceSize(w.slice);
    return {
        kind: 'worker',
        id: `sandbox:${s.sandbox_id || s.native_sandbox_id}:slot:${w.slot_id || i}`,
        slot: w.slot_key, slotId: w.slot_id, capacity: w.capacity_kind, state: w.state,
        task: a ? a.task_id : null, attempt: a ? a.id : null, generation: a ? a.generation : null,
        execution: a ? a.execution_state : null, authority: a ? a.compute_authority : null,
        runId: (r && r.run_id) || (a && a.run_id) || null,
        session: r ? r.session_id : null, runnerState: r ? r.state : null,
        heartbeat: r ? r.heartbeat_at : null,
        slice, sliceState: w.slice ? w.slice.state : null,
        snapshot: snap.state, snapshotId: snap.id || null, filesChanged: snap.files_changed || null,
        queue: Number.isInteger(w.queue_position) ? w.queue_position : null,
        sandbox: s.sandbox_id, provider: s.provider, pool: s.pool_id,
        description: [a ? `task ${a.task_id}` : 'idle', `slice ${slice.text}`, `snapshot ${snap.state}`].join(' · '),
    };
}

/* inventory: the console.sandboxes JSON. Returns the rows the tree draws, or
 * an error the view states instead of drawing stale rows. */
function sandboxNodes(inv) {
    if (!inv || typeof inv !== 'object') return { ok: false, error: 'no answer from hyperfide console sandboxes', nodes: [] };
    if (inv.ok === false || inv.error) {
        const e = inv.error || {};
        return { ok: false, error: `${e.code || 'ERROR'}: ${e.message || 'console.sandboxes refused'}`, nodes: [] };
    }
    if (inv.view !== 'console.sandboxes' || !Array.isArray(inv.rows))
        return { ok: false, error: 'the answer is not a console.sandboxes inventory', nodes: [] };
    const max = Number(inv.heartbeat_max_age_seconds) || null;
    const queue = queuePositions(inv.rows);
    const nodes = inv.rows.map((s, i) => {
        const age = s.heartbeat_age_seconds;
        const stale = age === null || age === undefined || (max !== null && Number(age) > max);
        const q = queue.has(i) ? queue.get(i) : null;
        const workers = (s.workers || []).map((w, j) => workerNode(s, w, j));
        return {
            kind: s.kind === 'ORPHAN' ? 'orphan' : 'sandbox',
            id: `sandbox:${s.sandbox_id || `orphan:${s.pool_id}:${s.native_sandbox_id}`}`,
            label: s.native_sandbox_id || s.sandbox_id,
            sandbox: s.sandbox_id, native: s.native_sandbox_id,
            liveness: s.liveness, reasons: s.reasons || [],
            provider: s.provider, region: s.region, pool: s.pool_id,
            heartbeatAge: age === undefined ? null : age, heartbeat: ageText(age), stale,
            queue: q, observed: s.observed_state, desired: s.desired_state,
            intent: s.intent ? `${s.intent.kind} ${s.intent.state}` : null,
            tasks: workers.filter((w) => w.task).map((w) => w.task),
            workers,
            description: [s.liveness, `${s.provider}/${s.pool_id}`, ageText(age),
                q !== null ? `queue #${q}` : null].filter(Boolean).join(' · '),
        };
    });
    return { ok: true, error: null, nodes, asOf: inv.as_of, counts: inv.counts || {}, truncated: !!inv.truncated };
}

/* The view's title line: freshness first, then the counts that matter. */
function summary(model) {
    if (!model || !model.ok) return model ? model.error : '';
    const c = model.counts;
    const parts = ['LIVE', 'PENDING', 'LOST', 'QUARANTINED', 'ORPHANED']
        .filter((k) => c[k]).map((k) => `${c[k]} ${k.toLowerCase()}`);
    return `as of ${model.asOf}${parts.length ? ' · ' + parts.join(' · ') : ''}${model.truncated ? ' · truncated' : ''}`;
}

/* Events of a worker's session: what the host forwarded and cg events holds,
 * matched on the session id (and on the attempt, which names the same run). */
function sessionEventOf(e, worker) {
    if (!e || !worker || !worker.session) return false;
    const p = e.payload || {};
    const ids = [e.session, e.subject, e.node, p.session, p.session_id, p.attempt_id];
    return ids.includes(worker.session) || (!!worker.attempt && ids.includes(worker.attempt));
}

/* The read-only document attach opens: who the session is, then its events. */
function sessionDocument(worker, events) {
    const lines = [
        `# session ${worker.session}`,
        '',
        `sandbox   ${worker.sandbox} (${worker.provider}/${worker.pool})`,
        `slot      ${worker.slot} ${worker.capacity || ''} ${worker.state || ''}`.trimEnd(),
        `run       ${worker.runId || '-'}`,
        `task      ${worker.task || '-'}  attempt ${worker.attempt || '-'} gen ${worker.generation || '-'} ${worker.execution || ''}`.trimEnd(),
        `runner    ${worker.runnerState || '-'}  heartbeat ${worker.heartbeat || '-'}`,
        `slice     ${worker.slice.text}`,
        `snapshot  ${worker.snapshot}${worker.snapshotId ? ` ${worker.snapshotId}` : ''}`,
        '',
    ];
    const rows = (events || []).filter((e) => sessionEventOf(e, worker));
    if (!rows.length) lines.push('(no events from this session have reached this host yet)');
    for (const e of rows) {
        const p = e.payload || {};
        const text = p.text || p.detail || p.tool || p.message || '';
        lines.push(`#${e.seq} ${e.ts || ''} ${e.kind}${text ? '  ' + String(text).replace(/\s+/g, ' ') : ''}`);
    }
    return lines.join('\n') + '\n';
}

/* ---------------- the view ---------------- */

function withTimeout(p, ms) {
    let timer;
    return Promise.race([
        Promise.resolve(p).then((v) => { clearTimeout(timer); return v; }, () => { clearTimeout(timer); return null; }),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
    ]);
}

function parseAnswer(r) {
    if (!r) return { ok: false, error: { code: 'TIMEOUT', message: `no answer in ${CALL_TIMEOUT_MS / 1000}s` } };
    for (const text of [r.stdout, r.stderr]) {
        try { const j = JSON.parse(String(text || '').trim()); if (j && typeof j === 'object') return j; } catch (_) { /* next */ }
    }
    return { ok: false, error: { code: `EXIT_${r.code}`, message: String(r.stderr || r.stdout || '').trim().split('\n')[0] || 'no output' } };
}

class SandboxesView {
    constructor(d) {
        this.deps = d;
        this.model = null;
        this.visible = false;
        this.force = true;
        this.byId = new Map();
        if (vscode) {
            this._em = new vscode.EventEmitter();
            this.onDidChangeTreeData = this._em.event;
        }
    }

    async load() {
        const r = await withTimeout(this.deps.cg(COMMAND), CALL_TIMEOUT_MS);
        this.model = sandboxNodes(parseAnswer(r));
        this.byId.clear();
        for (const n of this.model.nodes) {
            this.byId.set(n.id, n);
            for (const w of n.workers) this.byId.set(w.id, w);
        }
        if (this.view) this.view.message = summary(this.model);
        if (this._em) this._em.fire();
        return this.model;
    }

    /* the one scheduler calls this every pass; it is a no-op while hidden */
    async refresh() {
        if (!this.visible && !this.force) return;
        this.force = false;
        await this.load();
    }

    getChildren(el) {
        if (!this.model) return [];
        if (!el) return this.model.nodes;
        return el.workers || [];
    }

    getTreeItem(n) {
        const C = vscode.TreeItemCollapsibleState;
        if (n.kind === 'worker') {
            const it = new vscode.TreeItem(n.slot || n.slotId, C.None);
            it.id = n.id;
            it.description = n.description;
            it.iconPath = new vscode.ThemeIcon(n.task ? 'debug-start' : 'circle-outline');
            it.contextValue = n.session ? 'sandbox-worker-session' : 'sandbox-worker';
            it.tooltip = [`slot ${n.slot} (${n.capacity}, ${n.state})`, `task ${n.task || '-'} · attempt ${n.attempt || '-'} ${n.execution || ''}`,
                `session ${n.session || '-'} · runner ${n.runnerState || '-'}`, `heartbeat ${n.heartbeat || '-'}`,
                `slice ${n.slice.text}`, `snapshot ${n.snapshot}`, n.queue !== null ? `queue #${n.queue}` : ''].filter(Boolean).join('\n');
            if (n.session) it.command = { command: 'codify.sandboxes.attach', title: 'Attach', arguments: [{ node: n }] };
            return it;
        }
        const it = new vscode.TreeItem(n.label || '(unnamed)', n.workers.length ? C.Collapsed : C.None);
        it.id = n.id;
        it.description = n.description;
        const colour = n.liveness === 'LIVE' ? 'charts.green' : n.liveness === 'PENDING' ? 'charts.blue'
            : n.liveness === 'RETIRED' ? 'disabledForeground' : 'charts.red';
        it.iconPath = new vscode.ThemeIcon(n.kind === 'orphan' ? 'question' : 'vm', new vscode.ThemeColor(colour));
        it.contextValue = n.kind === 'orphan' ? 'sandbox-orphan' : 'sandbox';
        it.tooltip = [`${n.kind} ${n.sandbox || n.native} · ${n.liveness}`, ...n.reasons.map((r) => `  ${r}`),
            `provider ${n.provider} ${n.region || ''} · pool ${n.pool}`, `heartbeat ${n.heartbeat}${n.stale ? ' (stale)' : ''}`,
            `observed ${n.observed || '-'} · desired ${n.desired || '-'}`, n.intent ? `intent ${n.intent}` : '',
            n.queue !== null ? `queue #${n.queue}` : '', n.tasks.length ? `tasks ${n.tasks.join(' ')}` : ''].filter(Boolean).join('\n');
        return it;
    }

    nodeOf(arg) { return arg && arg.node ? arg.node : null; }

    workers() {
        const out = [];
        for (const n of (this.model && this.model.nodes) || []) for (const w of n.workers) if (w.session) out.push(w);
        return out;
    }
}

/* ---------------- commands and registration ---------------- */

let view;
let deps;
const documents = new Map();
let docEmitter = null;

async function cmdRefresh() {
    view.force = true;
    await view.refresh();
}

/* Attach: the worker's session, from the row or, from the palette, a pick of
 * every worker that has one. */
async function cmdAttach(arg) {
    let w = view.nodeOf(arg);
    if (!w) {
        if (!view.model) await view.load();
        const all = view.workers().map((x) => ({ label: x.session, description: `task ${x.task || '-'} · ${x.provider}/${x.pool}`,
            detail: `sandbox ${x.sandbox} · slot ${x.slot}`, w: x }));
        if (!all.length) {
            vscode.window.showInformationMessage('No sandbox worker has a session to attach to.');
            return;
        }
        const pick = await vscode.window.showQuickPick(all, { placeHolder: 'Attach to which worker session?' });
        if (!pick) return;
        w = pick.w;
    }
    if (!w || !w.session) {
        vscode.window.showInformationMessage('This worker has no runner session yet.');
        return;
    }
    const r = await withTimeout(deps.cg(['events', '--kind', 'agent.,supervisor.,drift.,ask.', '-n', '400', '--json']), CALL_TIMEOUT_MS);
    const events = String((r && r.stdout) || '').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const uri = vscode.Uri.parse(`${SESSION_SCHEME}:/${encodeURIComponent(w.session)}.log`);
    documents.set(uri.toString(), sessionDocument(w, events));
    docEmitter.fire(uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
}

function register(ctx, d) {
    deps = d;
    view = new SandboxesView(d);
    const tv = vscode.window.createTreeView('codifySandboxes', { treeDataProvider: view, showCollapseAll: true });
    view.view = tv;
    view.visible = tv.visible;
    ctx.subscriptions.push(tv, tv.onDidChangeVisibility((e) => {
        view.visible = e.visible;
        if (e.visible) { view.force = true; view.refresh(); }
    }));
    docEmitter = new vscode.EventEmitter();
    ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SESSION_SCHEME, {
        onDidChange: docEmitter.event,
        provideTextDocumentContent: (uri) => documents.get(uri.toString()) || '',
    }));
    const cmds = {
        'codify.sandboxes.refresh': cmdRefresh,
        'codify.sandboxes.attach': cmdAttach,
    };
    for (const [name, fn] of Object.entries(cmds)) ctx.subscriptions.push(vscode.commands.registerCommand(name, fn));
    return {
        refresh: () => view.refresh(),
        get visible() { return view.visible; },
    };
}

module.exports = { register, SandboxesView, sandboxNodes, sliceSize, queuePositions, summary,
                   sessionEventOf, sessionDocument, parseAnswer, ageText, COMMAND };
