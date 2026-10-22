/* Hyperfide Needs view (hyperfide-v21 6.2) — what a person owes the run.
 *
 * Sources, folded into one tree:
 *
 *   - console.needs, the service read model (observability/console.ts, 5.3):
 *     asks (OPEN, or EXPIRED and still blocking), human_intents and
 *     admission_escalations, every row {kind,id,state,title,since,freshness,
 *     references,detail}. Reached through `cg console needs --json`.
 *   - the local Asks, `cg ask list --json` (src/ask.c): shown whenever the
 *     console is not reachable, which is every local-mode project.
 *
 * An Ask row carries its kind, task, deadline and recommended option. The
 * deadline and what happens at it are the 3.6 ask policy's: default_policy
 * block keeps the task waiting past it (the row stays, marked overdue);
 * proceed-and-flag takes the recommended option at it (`cg ask expire`), so
 * the row leaves on the next pass. The view never expires anything itself.
 *
 * Answering settles through cg in both modes, so cg's checks are the only
 * ones: a local row runs `cg ask answer <id> <answer>`; a console row runs
 * the routed form (human.ask.answer, --input-file with ask_id,
 * expected_state_version and answer). A secret is answered with a
 * secret-ref:<id> and the input refuses anything else before cg sees it, so
 * a raw value never reaches a process argument or a file.
 *
 * needsModel() and answerPlan() are pure and vscode-free so a shell tests them. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
let vscode = null;
try { vscode = require('vscode'); } catch (_) { /* headless: model only */ }

const CONSOLE_ARGS = ['console', 'needs'];
const LOCAL_ARGS = ['ask', 'list'];
const CALL_TIMEOUT_MS = 20000;
const SECRET_REF = /^secret-ref:[A-Za-z0-9._-]{1,200}$/;

const SECTIONS = [
    { key: 'asks', label: 'Asks', icon: 'question' },
    { key: 'human_intents', label: 'Human intents', icon: 'person' },
    { key: 'admission_escalations', label: 'Admission escalations', icon: 'shield' },
];
const KIND_ICON = { secret: 'key', variable: 'symbol-variable', permission: 'unlock',
                    decision: 'git-merge', question: 'comment-discussion' };

/* ---------------- the join (pure, no vscode) ---------------- */

function consolePanel(j) {
    const seen = new Set();
    const visit = (o, depth) => {
        if (!o || typeof o !== 'object' || Array.isArray(o) || depth > 3 || seen.has(o)) return null;
        seen.add(o);
        if (o.view === 'console.needs' && o.sections && typeof o.sections === 'object') return o;
        for (const k of ['result', 'data', 'output', 'panel']) {
            const hit = visit(o[k], depth + 1);
            if (hit) return hit;
        }
        return null;
    };
    return visit(j, 0);
}

function localAsks(j) {
    const list = j && Array.isArray(j.asks) ? j.asks : Array.isArray(j) ? j : null;
    return list ? list.filter((a) => a && a.id != null && a.kind) : null;
}

function toIso(v) {
    if (v == null || v === '') return null;
    const t = typeof v === 'number' ? v * 1000 : Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/* One Ask row from either source, in one shape. */
function askRow(a, source, scope) {
    const console_ = source === 'console';
    const d = console_ ? (a.detail || {}) : a;
    const refs = console_ ? (a.references || {}) : {};
    const options = Array.isArray(d.options) ? d.options.map(String) : [];
    const deadline = toIso(d.deadline);
    const state = String(a.state || '').toLowerCase();
    const policy = d.default_policy || null;
    const now = Date.now();
    return {
        source, key: `${source}:ask:${a.id}`, id: String(a.id), section: 'asks',
        kind: String(console_ ? d.ask_kind : a.kind), title: a.title || '',
        body: d.body || '', state, options, recommended: d.recommended || null,
        deadline, policy, blocking: !!d.blocking,
        overdue: d.overdue != null ? !!d.overdue : !!(deadline && Date.parse(deadline) <= now),
        task: console_ ? (refs.task_key || refs.task_id || null) : (a.task || null),
        stateVersion: d.state_version != null ? String(d.state_version) : null,
        runId: console_ ? (refs.run_id || (scope && scope.run_id) || null) : null,
        answerable: state === 'open' || (state === 'expired' && policy === 'block'),
    };
}

function otherRow(section, r) {
    const refs = r.references || {};
    return {
        source: 'console', key: `console:${section}:${r.id}`, id: String(r.id), section,
        kind: String(r.kind || '').toLowerCase(), title: r.title || '', state: String(r.state || '').toLowerCase(),
        task: refs.task_key || refs.task_id || null, deadline: toIso((r.detail || {}).retry_after),
        recommended: null, options: [], since: r.since || null, answerable: false,
    };
}

/* The view model. `panel` is the console verb's output (or null), `local`
 * the `cg ask list --json` output (or null). The console wins when it
 * answers: in distributed mode the local table is not the authority. */
function needsModel(panel, local) {
    const p = consolePanel(panel);
    const sections = SECTIONS.map((s) => ({ ...s, rows: [], truncated: false }));
    const by = Object.fromEntries(sections.map((s) => [s.key, s]));
    if (p) {
        for (const s of sections) {
            const sec = p.sections[s.key];
            if (!sec) continue;
            s.truncated = !!sec.truncated;
            for (const r of sec.rows || []) {
                s.rows.push(s.key === 'asks' ? askRow(r, 'console', p.scope) : otherRow(s.key, r));
            }
        }
    } else {
        for (const a of localAsks(local) || []) {
            if (a.state === 'open' || (a.state === 'expired' && a.blocking)) by.asks.rows.push(askRow(a, 'local'));
        }
    }
    /* nearest deadline first; no deadline last */
    by.asks.rows.sort((a, b) => (a.deadline ? Date.parse(a.deadline) : Infinity) -
                                (b.deadline ? Date.parse(b.deadline) : Infinity) || a.id.localeCompare(b.id));
    const total = sections.reduce((n, s) => n + s.rows.length, 0);
    return {
        available: !!p, localAvailable: !!localAsks(local), asOf: p ? p.as_of : null,
        scope: p ? p.scope : null, sections, total,
        overdue: by.asks.rows.filter((r) => r.overdue).length,
        counts: Object.fromEntries(sections.map((s) => [s.key, s.rows.length])),
    };
}

/* How the person answers a row: which input, and its constraints.
 *   quickpick — the row offers options (decision, question, permission)
 *   password  — a secret: the value must be a secret-ref:
 *   text      — a question or variable with no options */
function answerPlan(row) {
    if (!row || !row.answerable) return null;
    if (row.kind === 'secret') return { input: 'password', validate: validateSecret };
    if (row.options.length) {
        const rec = row.recommended;
        const items = [...row.options].sort((a, b) => (b === rec) - (a === rec))
            .map((o) => ({ label: o, description: o === rec ? 'recommended' : undefined, value: o }));
        return { input: 'quickpick', items };
    }
    return { input: 'text', validate: (v) => (String(v || '').trim() ? null : 'An answer is required') };
}

function validateSecret(v) {
    return SECRET_REF.test(String(v || '')) ? null
        : 'Answer with a reference (secret-ref:<id>), never the secret value';
}

/* The cg invocation that settles an answer. Local: the plain verb. Console:
 * the routed verb with the service's human.ask.answer input, written to a
 * file the caller removes. Returns null when the answer is refused here. */
function answerCommand(row, answer, dir) {
    if (!row || !row.answerable) return null;
    if (row.kind === 'secret' && validateSecret(answer)) return null;
    if (row.options.length && !row.options.includes(answer)) return null;
    if (row.source === 'local') return { args: ['ask', 'answer', row.id, answer], file: null };
    if (!row.runId || row.stateVersion == null) return null;
    const file = path.join(dir || os.tmpdir(), `hyperfide-answer-${crypto.randomUUID()}.json`);
    const input = { ask_id: row.id, expected_state_version: row.stateVersion, answer };
    const op = crypto.randomUUID();
    return {
        args: ['ask', 'answer', '--input-file', file, '--run-id', row.runId, '--operation-id', op,
               '--idempotency-key', op, '--correlation-id', crypto.randomUUID()],
        file, input,
    };
}

function relDeadline(iso, now) {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return '';
    const s = Math.round((t - (now || Date.now())) / 1000), a = Math.abs(s);
    const v = a < 90 ? `${a}s` : a < 5400 ? `${Math.round(a / 60)}m` : a < 172800 ? `${Math.round(a / 3600)}h` : `${Math.floor(a / 86400)}d`;
    return s <= 0 ? `overdue ${v}` : `due in ${v}`;
}

function withTimeout(p, ms, onTimeout) {
    let timer;
    return Promise.race([
        Promise.resolve(p).finally(() => clearTimeout(timer)),
        new Promise((resolve) => { timer = setTimeout(() => { onTimeout(); resolve(null); }, ms); }),
    ]);
}

/* ---------------- the view ---------------- */

class NeedsView {
    constructor(deps) {
        this.deps = deps;
        this._em = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._em.event;
        this.model = null;
        this.state = 'loading';
        this.consoleError = null;
        this.visible = true;
        this.force = false;
        this.view = null;
    }

    async refresh() {
        if (!this.visible && !this.force) return;
        this.force = false;
        const { cgJson } = this.deps;
        let timedOut = null;
        const raw = await withTimeout(cgJson(CONSOLE_ARGS), CALL_TIMEOUT_MS,
            () => { timedOut = `\`cg ${CONSOLE_ARGS.join(' ')}\` did not answer in ${CALL_TIMEOUT_MS / 1000}s`; });
        const panel = consolePanel(raw);
        let local = null;
        if (!panel) local = await withTimeout(cgJson(LOCAL_ARGS), CALL_TIMEOUT_MS, () => {});
        this.consoleError = panel ? null : timedOut ||
            (raw && raw.error && (raw.error.message || raw.error.code)) ||
            'the Hyperfide console is not reachable from this cg';
        this.model = needsModel(panel, local);
        this.state = 'ready';
        this._done();
    }

    /* ask.* pushed through cg serve: the catch-up refresh the extension
     * queues for every event redraws this view even while it is hidden */
    route(ev) {
        if (!ev || !ev.kind || !String(ev.kind).startsWith('ask.')) return false;
        this.force = true;
        return true;
    }

    _done() {
        this._em.fire();
        const m = this.model;
        if (this.view && m) {
            this.view.description = `${m.total} waiting` + (m.overdue ? ` · ${m.overdue} overdue` : '') +
                (m.available ? '' : ' · local');
            this.view.badge = m.total
                ? { value: m.total, tooltip: `${m.total} need${m.total === 1 ? 's' : ''} a person` } : undefined;
        }
    }

    getTreeItem(el) { return el; }

    getChildren(el) {
        if (el) return el.childItems || [];
        if (this.state === 'loading' || !this.model) {
            const it = new vscode.TreeItem('Loading needs…', vscode.TreeItemCollapsibleState.None);
            it.iconPath = new vscode.ThemeIcon('sync~spin');
            return [it];
        }
        const top = [];
        if (!this.model.available) {
            const it = new vscode.TreeItem('Hyperfide console not reachable', vscode.TreeItemCollapsibleState.None);
            it.id = 'needs:offline';
            it.description = 'showing local Asks · click to retry';
            it.tooltip = `${this.consoleError}. Human intents and admission escalations come from ` +
                'console.needs; the Asks below are this project\'s local ones.';
            it.iconPath = new vscode.ThemeIcon('debug-disconnect');
            it.command = { command: 'codify.needs.refresh', title: 'Retry' };
            it.contextValue = 'needs-notice';
            top.push(it);
        }
        for (const s of this.model.sections) {
            if (!this.model.available && s.key !== 'asks') continue;
            top.push(this.sectionItem(s));
        }
        return top;
    }

    sectionItem(s) {
        const kids = s.rows.map((r) => this.rowItem(r));
        const it = new vscode.TreeItem(s.label, kids.length
            ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        it.id = `needs:${s.key}`;
        it.childItems = kids;
        it.description = `${s.rows.length}${s.truncated ? '+' : ''}`;
        it.iconPath = new vscode.ThemeIcon(s.icon);
        it.contextValue = 'needs-section';
        return it;
    }

    rowItem(r) {
        const it = new vscode.TreeItem(r.title, vscode.TreeItemCollapsibleState.None);
        it.id = `needs:${r.key}`;
        it.row = r;
        const due = relDeadline(r.deadline);
        it.description = [r.kind, r.task, due, r.recommended ? `→ ${r.recommended}` : null]
            .filter(Boolean).join(' · ');
        it.tooltip = [r.title, r.body, `kind: ${r.kind}`, r.task ? `task: ${r.task}` : null,
                      r.deadline ? `deadline: ${r.deadline} (${due})` : 'no deadline',
                      r.policy ? `at the deadline: ${r.policy === 'block' ? 'keeps the task waiting' : 'proceeds on the recommendation'}` : null,
                      r.recommended ? `recommended: ${r.recommended}` : null,
                      r.options.length ? `options: ${r.options.join(', ')}` : null].filter(Boolean).join('\n');
        it.iconPath = new vscode.ThemeIcon(KIND_ICON[r.kind] || 'bell',
            r.overdue ? new vscode.ThemeColor('list.errorForeground') : undefined);
        it.contextValue = r.answerable ? 'needs-row-answerable' : 'needs-row';
        if (r.answerable) it.command = { command: 'codify.needs.answer', title: 'Answer', arguments: [it] };
        return it;
    }
}

/* ---------------- registration ---------------- */

let view;

async function cmdAnswer(arg) {
    const r = arg && arg.row;
    const plan = answerPlan(r);
    if (!plan) return;
    let answer;
    if (plan.input === 'quickpick') {
        const pick = await vscode.window.showQuickPick(plan.items,
            { title: r.title, placeHolder: r.body || `Answer this ${r.kind}`, ignoreFocusOut: true });
        answer = pick && pick.value;
    } else {
        answer = await vscode.window.showInputBox({
            title: r.title, prompt: r.body || `Answer this ${r.kind}`, ignoreFocusOut: true,
            password: plan.input === 'password',
            placeHolder: plan.input === 'password' ? 'secret-ref:<id>' : undefined,
            validateInput: plan.validate,
        });
    }
    if (answer == null || answer === '') return;
    const cmd = answerCommand(r, answer);
    if (!cmd) { vscode.window.showErrorMessage('Hyperfide: that answer cannot settle this Ask.'); return; }
    try {
        if (cmd.file) fs.writeFileSync(cmd.file, JSON.stringify(cmd.input), { mode: 0o600 });
        const res = await view.deps.cg(cmd.args);
        if (!res || res.code !== 0) {
            const msg = String((res && (res.stderr || res.stdout)) || 'cg did not answer').trim();
            vscode.window.showErrorMessage(`Hyperfide: ${msg}`);
            return;
        }
        vscode.window.setStatusBarMessage(`Hyperfide: answered ${r.kind} "${r.title}"`, 6000);
    } finally {
        if (cmd.file) { try { fs.unlinkSync(cmd.file); } catch (_) { /* gone */ } }
    }
    view.force = true;
    await view.refresh();
}

function register(ctx, d) {
    view = new NeedsView(d);
    const tv = vscode.window.createTreeView('codifyNeeds', { treeDataProvider: view, showCollapseAll: true });
    view.view = tv;
    view.visible = tv.visible;
    ctx.subscriptions.push(tv, tv.onDidChangeVisibility((e) => {
        view.visible = e.visible;
        if (e.visible) { view.force = true; view.refresh(); }
    }));
    const cmds = {
        'codify.needs.refresh': async () => { view.force = true; await view.refresh(); },
        'codify.needs.answer': cmdAnswer,
    };
    for (const [name, fn] of Object.entries(cmds)) {
        ctx.subscriptions.push(vscode.commands.registerCommand(name, fn));
    }
    return {
        refresh: () => view.refresh(),
        route: (ev) => view.route(ev),
        get visible() { return view.visible; },
    };
}

module.exports = { register, NeedsView, needsModel, answerPlan, answerCommand, consolePanel,
                   localAsks, validateSecret, CONSOLE_ARGS, LOCAL_ARGS };
