/* Hyperfide Issues view (hyperfide-v21 6.3) — what is wrong, not what is asked.
 *
 * Two sources fold into one tree and one DiagnosticCollection:
 *
 *   - console.issues, the service's read model (observability/console.ts):
 *     leader queue, external intake, escalated repairs and observation drift,
 *     every row {kind,id,state,title,since,freshness,references,detail}.
 *   - the local drift.* events cg writes (drift.c, orchestrate.c): a task's
 *     change outside its touches (drift.spec), an interface change with live
 *     reference sites (drift.interface), a serialised collision
 *     (drift.collision) and uncovered criteria (drift.coverage). They arrive
 *     pushed through cg serve (route) and on every refresh from cg events.
 *
 * A row is blocked while it holds work: an escalated repair whose decision
 * Ask is still OPEN, a row whose task is in status blocked, or a collision
 * whose task waits for another. Resolution clears it — the Ask answered, the
 * row gone from the read model, the awaited task done — and the diagnostics
 * of a resolved row go with it, because the collection is rebuilt from the
 * model on every pass rather than patched.
 *
 * issuesModel() is pure and vscode-free so a shell can test the join. */
const path = require('path');
let vscode = null;
try { vscode = require('vscode'); } catch (_) { /* headless: model only */ }

/* The 5.3 console verb (Ask in the 6.3 report): until it exists, or in a
 * local-mode project, it prints no JSON and the service sections say so. */
const CONSOLE_ARGS = ['console', 'issues'];
const DRIFT_EVENTS = ['events', '--kind', 'drift.,task.status', '-n', '500', '--json'];
const CALL_TIMEOUT_MS = 20000;

const SECTIONS = [
    { key: 'leader_queue', label: 'Leader queue', icon: 'inbox' },
    { key: 'external_intake', label: 'External intake', icon: 'issues' },
    { key: 'escalated_repairs', label: 'Escalated repairs', icon: 'tools' },
    { key: 'drift', label: 'Drift', icon: 'git-compare' },
];
const SEVERITY = { CRITICAL: 'error', ERROR: 'error', WARNING: 'warning', INFO: 'info' };

/* ---------------- the join (pure, no vscode) ---------------- */

/* The bare panel, or the panel inside whatever envelope the client wraps it
 * in. Anything that is not console.issues is no panel at all. */
function consolePanel(j) {
    const seen = new Set();
    const visit = (o, depth) => {
        if (!o || typeof o !== 'object' || Array.isArray(o) || depth > 3 || seen.has(o)) return null;
        seen.add(o);
        if (o.view === 'console.issues' && o.sections && typeof o.sections === 'object') return o;
        for (const k of ['result', 'data', 'output', 'panel']) {
            const hit = visit(o[k], depth + 1);
            if (hit) return hit;
        }
        return null;
    };
    return visit(j, 0);
}

/* File locations a console row names in its detail, in either shape a
 * finding carries them: {path,line} or locations:[{path,line}]. */
function rowLocations(detail) {
    const d = detail || {};
    const list = Array.isArray(d.locations) ? d.locations : d.path ? [d] : [];
    return list.filter((l) => l && typeof l.path === 'string' && l.path)
        .map((l) => ({ path: l.path, line: Number.isInteger(+l.line) && +l.line > 0 ? +l.line : 1 }));
}

function consoleRow(section, r) {
    const d = r.detail || {};
    const ask = d.ask && typeof d.ask === 'object' ? d.ask : null;
    const blockedBy = ask && ask.state === 'OPEN' ? (r.references && r.references.ask_id) || 'ask'
        : d.task_state === 'blocked' ? (r.references && r.references.task_id) || 'task' : null;
    const severity = SEVERITY[d.severity] || (section === 'drift' ? 'warning' : 'info');
    return {
        source: 'console', section, key: `console:${section}:${r.id}`, kind: r.kind, id: r.id,
        state: r.state, title: r.title, since: r.since, freshness: r.freshness || null,
        references: r.references || {}, detail: d, severity,
        blocked: !!blockedBy, blockedBy,
        locations: rowLocations(d).map((l) => ({ ...l, message: r.title })),
    };
}

/* Fold the drift.* and task.status events (oldest first, as cg events and
 * serve deliver them) into the drift rows still standing. A newer event of
 * the same kind and subject replaces an older one; a task reaching done
 * resolves the collisions that waited on it or for it. */
function driftRows(events) {
    const rows = new Map();
    const order = [...(events || [])].filter((e) => e && e.kind)
        .sort((a, b) => (a.seq || 0) - (b.seq || 0));
    for (const ev of order) {
        const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
        const subject = String(ev.subject || '');
        if (ev.kind === 'task.status') {
            if (p.status !== 'done' && p.status !== 'superseded') continue;
            const slash = subject.indexOf('/');
            const feature = p.feature || (slash < 0 ? '' : subject.slice(0, slash));
            const id = slash < 0 ? subject : subject.slice(slash + 1);
            for (const [k, r] of rows) {
                if (r.drift === 'collision' && r.feature === feature && (r.task === id || r.with === id)) rows.delete(k);
            }
            continue;
        }
        if (!ev.kind.startsWith('drift.')) continue;
        const drift = ev.kind.slice('drift.'.length);
        const slash = subject.indexOf('/');
        const base = { source: 'local', section: 'drift', kind: 'DRIFT', drift, seq: ev.seq || 0,
            since: ev.at ? new Date(ev.at).toISOString() : null, branch: ev.branch || null,
            feature: slash < 0 ? (p.feature || subject) : subject.slice(0, slash),
            task: null, with: null, blocked: false, blockedBy: null, severity: 'warning',
            references: {}, detail: p, locations: [] };
        let r;
        if (drift === 'spec') {
            const outside = Array.isArray(p.files_outside) ? p.files_outside : [];
            const undeclared = Array.isArray(p.symbols_undeclared) ? p.symbols_undeclared : [];
            r = { ...base, task: subject, state: 'OUTSIDE_DECLARATION',
                  title: `${subject}: ${outside.length} file${outside.length === 1 ? '' : 's'} outside touches, ` +
                         `${undeclared.length} undeclared symbol${undeclared.length === 1 ? '' : 's'}`,
                  locations: [
                      ...outside.map((f) => ({ path: String(f), line: 1, message: `${subject} changed ${f} outside its touches` })),
                      ...undeclared.filter((s) => s && s.path).map((s) => ({ path: s.path, line: s.line || 1,
                          message: `${subject} changed ${s.name}, which it does not declare` })),
                  ] };
        } else if (drift === 'interface') {
            const sites = Array.isArray(p.sites) ? p.sites : [];
            r = { ...base, task: p.task || null, state: String(p.change || 'CHANGED').toUpperCase(),
                  title: `${p.symbol} ${p.change || 'changed'} in ${p.path}; ${sites.length} reference site${sites.length === 1 ? '' : 's'}`,
                  locations: [
                      ...(p.path ? [{ path: p.path, line: 1, message: `${p.symbol} ${p.change}: ${p.old || ''} -> ${p.new || '(removed)'}` }] : []),
                      ...sites.filter((s) => s && s.path).map((s) => ({ path: s.path, line: s.line || 1,
                          message: `uses ${p.symbol}, whose interface ${p.change}${s.branch ? ` on ${s.branch}` : ''}` })),
                  ] };
            r.key = `local:interface:${p.symbol}:${p.path}`;
        } else if (drift === 'collision') {
            const id = p.task || (slash < 0 ? subject : subject.slice(slash + 1));
            r = { ...base, task: id, with: p.with || null, state: 'WAITING', blocked: true,
                  blockedBy: p.with || null, title: `${id} waits for ${p.with}: ${p.why || 'predicted collision'}` };
        } else if (drift === 'coverage') {
            const n = Number(p.uncovered) || 0;
            r = { ...base, feature: p.feature || subject, state: 'UNCOVERED',
                  title: `${p.feature || subject}: ${n} of ${p.total} acceptance criteria uncovered` };
            if (!n) { rows.delete(`local:coverage:${subject}`); continue; }
        } else {
            r = { ...base, state: drift.toUpperCase(), title: `${ev.kind} ${subject}` };
        }
        r.key = r.key || `local:${drift}:${subject}`;
        r.id = r.key;
        rows.set(r.key, r);
    }
    return [...rows.values()];
}

/* The whole view model. `panel` is console.issues or null (unreachable);
 * `events` the drift.* and task.status events. Diagnostics are grouped per
 * path, relative to the workspace root the view resolves them against. */
function issuesModel(panel, events, opts) {
    const o = opts || {};
    const sections = SECTIONS.map((s) => ({ ...s, rows: [], truncated: false }));
    const by = Object.fromEntries(sections.map((s) => [s.key, s]));
    const p = consolePanel(panel);
    if (p) {
        for (const s of sections) {
            const sec = p.sections[s.key];
            if (!sec) continue;
            s.truncated = !!sec.truncated;
            for (const r of sec.rows || []) s.rows.push(consoleRow(s.key, r));
        }
    }
    for (const r of driftRows(events)) by.drift.rows.push(r);
    const diagnostics = {};
    let blocked = 0;
    for (const s of sections) {
        for (const r of s.rows) {
            if (r.blocked) blocked++;
            for (const l of r.locations) {
                (diagnostics[l.path] || (diagnostics[l.path] = [])).push({
                    line: l.line, message: l.message || r.title, severity: r.severity,
                    source: r.source === 'console' ? `hyperfide ${r.kind.toLowerCase()}` : `hyperfide drift.${r.drift}`,
                    key: r.key,
                });
            }
        }
    }
    const total = sections.reduce((n, s) => n + s.rows.length, 0);
    /* what the previous pass held blocked and this one no longer does */
    const prev = o.previous || null;
    const nowBlocked = new Set(sections.flatMap((s) => s.rows.filter((r) => r.blocked).map((r) => r.key)));
    const cleared = prev ? prev.sections.flatMap((s) => s.rows)
        .filter((r) => r.blocked && !nowBlocked.has(r.key)) : [];
    return {
        available: !!p, asOf: p ? p.as_of : null, scope: p ? p.scope : null,
        sections, total, blocked, diagnostics, cleared,
        counts: Object.fromEntries(sections.map((s) => [s.key, s.rows.length])),
    };
}

function relAge(iso, now) {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, Math.round(((now || Date.now()) - t) / 1000));
    return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago`
        : s < 172800 ? `${Math.round(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}

function withTimeout(p, ms, onTimeout) {
    let timer;
    return Promise.race([
        Promise.resolve(p).finally(() => clearTimeout(timer)),
        new Promise((resolve) => { timer = setTimeout(() => { onTimeout(); resolve(null); }, ms); }),
    ]);
}

function parseLines(stdout) {
    return String(stdout || '').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/* ---------------- the view ---------------- */

class IssuesView {
    constructor(deps) {
        this.deps = deps;
        this._em = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._em.event;
        this.panel = null;
        this.events = [];
        this.model = null;
        this.state = 'loading';       /* loading | ready */
        this.consoleError = null;
        this.visible = true;
        this.force = false;
        this.view = null;
        this.diagnostics = deps.diagnostics || null;
    }

    /* One pass: the read model and the drift log, each raced against the
     * timeout. A missing console is a notice row, never a failed view. */
    async refresh() {
        if (!this.visible && !this.force) return;
        this.force = false;
        const { cgJson, cg } = this.deps;
        let timedOut = null;
        const raw = await withTimeout(cgJson(CONSOLE_ARGS), CALL_TIMEOUT_MS,
            () => { timedOut = `\`cg ${CONSOLE_ARGS.join(' ')}\` did not answer in ${CALL_TIMEOUT_MS / 1000}s`; });
        this.panel = consolePanel(raw);
        this.consoleError = this.panel ? null : timedOut ||
            (raw && raw.error && (raw.error.message || raw.error.code)) ||
            'the Hyperfide console is not reachable from this cg';
        const evr = await withTimeout(cg(DRIFT_EVENTS), CALL_TIMEOUT_MS, () => {});
        if (evr && evr.code === 0) this.events = parseLines(evr.stdout);
        this.rebuild();
    }

    /* a drift.* event pushed through cg serve: folded on at once, and the
     * next refresh brings it again from the log, so it is never counted twice */
    route(ev) {
        if (!ev || !ev.kind || !(ev.kind.startsWith('drift.') || ev.kind === 'task.status')) return false;
        if (ev.seq && this.events.some((e) => e.seq === ev.seq)) return false;
        this.events.push(ev);
        this.force = true;
        this.rebuild();
        return true;
    }

    rebuild() {
        const prev = this.model;
        this.model = issuesModel(this.panel, this.events, { previous: prev });
        this.state = 'ready';
        this.publishDiagnostics();
        if (this.model.cleared.length && this.deps.onCleared) {
            try { this.deps.onCleared(this.model.cleared); } catch (_) { /* best effort */ }
        }
        this._done();
    }

    publishDiagnostics() {
        const dc = this.diagnostics;
        if (!dc) return;
        const root = this.deps.workspaceRoot ? this.deps.workspaceRoot() : null;
        dc.clear();
        for (const [p, list] of Object.entries(this.model.diagnostics)) {
            const abs = path.isAbsolute(p) || !root ? p : path.join(root, p);
            dc.set(vscode.Uri.file(abs), list.map((d) => {
                const line = Math.max(0, (d.line || 1) - 1);
                const dg = new vscode.Diagnostic(new vscode.Range(line, 0, line, 0x7fffffff), d.message,
                    d.severity === 'error' ? vscode.DiagnosticSeverity.Error
                        : d.severity === 'warning' ? vscode.DiagnosticSeverity.Warning
                        : vscode.DiagnosticSeverity.Information);
                dg.source = d.source;
                dg.code = d.key;
                return dg;
            }));
        }
    }

    _done() {
        this._em.fire();
        const m = this.model;
        if (this.view && m) {
            this.view.description = `${m.total} open` + (m.blocked ? ` · ${m.blocked} blocked` : '') +
                (m.available ? '' : ' · console offline');
            this.view.badge = m.blocked
                ? { value: m.blocked, tooltip: `${m.blocked} issue${m.blocked === 1 ? '' : 's'} holding work` }
                : undefined;
        }
    }

    getTreeItem(el) { return el; }

    getChildren(el) {
        if (el) return el.childItems || [];
        if (this.state === 'loading' || !this.model) {
            const it = new vscode.TreeItem('Loading issues…', vscode.TreeItemCollapsibleState.None);
            it.iconPath = new vscode.ThemeIcon('sync~spin');
            return [it];
        }
        const top = [];
        if (!this.model.available) {
            const it = new vscode.TreeItem('Hyperfide console not reachable', vscode.TreeItemCollapsibleState.None);
            it.id = 'issues:offline';
            it.description = 'click to retry';
            it.tooltip = `${this.consoleError}. Leader queue, external intake and escalated repairs ` +
                'come from console.issues; local drift is shown below.';
            it.iconPath = new vscode.ThemeIcon('debug-disconnect');
            it.command = { command: 'codify.issues.refresh', title: 'Retry' };
            it.contextValue = 'issues-notice';
            top.push(it);
        }
        for (const s of this.model.sections) {
            if (!this.model.available && s.key !== 'drift') continue;
            top.push(this.sectionItem(s));
        }
        return top;
    }

    sectionItem(s) {
        const kids = s.rows.map((r) => this.rowItem(r));
        const it = new vscode.TreeItem(s.label, kids.length
            ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        it.id = `issues:${s.key}`;
        it.childItems = kids;
        const blocked = s.rows.filter((r) => r.blocked).length;
        it.description = `${s.rows.length}${s.truncated ? '+' : ''}` + (blocked ? ` · ${blocked} blocked` : '');
        it.iconPath = new vscode.ThemeIcon(s.icon);
        it.contextValue = 'issues-section';
        return it;
    }

    rowItem(r) {
        const it = new vscode.TreeItem(r.title, vscode.TreeItemCollapsibleState.None);
        it.id = `issues:${r.key}`;
        it.row = r;
        const age = relAge(r.since);
        it.description = [r.blocked ? 'blocked' : r.state, r.source === 'local' ? `drift.${r.drift}` : null,
                          age, r.freshness && r.freshness.stale ? 'stale' : null].filter(Boolean).join(' · ');
        const refs = Object.entries(r.references || {}).filter(([, v]) => v)
            .map(([k, v]) => `${k}: ${v}`);
        it.tooltip = [r.title, `${r.kind} ${r.state}`, r.blocked ? `blocked by ${r.blockedBy}` : null,
                      ...refs, ...r.locations.map((l) => `${l.path}:${l.line}`)].filter(Boolean).join('\n');
        it.iconPath = new vscode.ThemeIcon(r.blocked ? 'circle-slash' : r.severity === 'error' ? 'error' : 'warning',
            new vscode.ThemeColor(r.severity === 'error' || r.blocked ? 'list.errorForeground' : 'list.warningForeground'));
        it.contextValue = r.blocked ? 'issues-row-blocked' : 'issues-row';
        if (r.locations.length) {
            it.command = { command: 'codify.issues.open', title: 'Open location', arguments: [it] };
        }
        return it;
    }
}

/* ---------------- registration ---------------- */

let view;

async function cmdOpen(arg) {
    const r = arg && arg.row;
    const l = r && r.locations[0];
    if (!l) return;
    const root = view.deps.workspaceRoot ? view.deps.workspaceRoot() : null;
    const abs = path.isAbsolute(l.path) || !root ? l.path : path.join(root, l.path);
    const line = Math.max(0, l.line - 1);
    await vscode.window.showTextDocument(vscode.Uri.file(abs),
        { selection: new vscode.Range(line, 0, line, 0), preview: true });
}

function register(ctx, d) {
    const diagnostics = vscode.languages.createDiagnosticCollection('hyperfide-issues');
    ctx.subscriptions.push(diagnostics);
    view = new IssuesView({
        ...d, diagnostics,
        onCleared: (rows) => {
            const names = rows.map((r) => r.task || r.id).join(', ');
            vscode.window.setStatusBarMessage(`Hyperfide: resolved, no longer blocked — ${names}`, 8000);
        },
    });
    const tv = vscode.window.createTreeView('codifyIssues', { treeDataProvider: view, showCollapseAll: true });
    view.view = tv;
    view.visible = tv.visible;
    ctx.subscriptions.push(tv, tv.onDidChangeVisibility((e) => {
        view.visible = e.visible;
        if (e.visible) { view.force = true; d.refresh(); }
    }));
    const cmds = {
        'codify.issues.refresh': async () => { view.force = true; await view.refresh(); },
        'codify.issues.open': cmdOpen,
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

module.exports = { register, IssuesView, issuesModel, consolePanel, driftRows, rowLocations,
                   CONSOLE_ARGS };
