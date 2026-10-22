'use strict';
/* The global Ask registry (hyperfide-v21 task 6.1, req 5.4).
 *
 * Three things wait on a person, from three places:
 *   acp       an ACP session/request_permission an agent in one of this
 *             window's chats is blocked on (agents.js AgentPanel);
 *   approval  a fleet approval gate (cg fleet approvals, approval.* events);
 *   ask       a durable Ask (cg ask list, the serve snapshot's asks array,
 *             ask.raised / ask.answered / ask.expired events).
 * A fleet gate is also a permission Ask (src/fleet.c fleet_gate): the two are
 * one item here, answered through `cg fleet approve`, which decides both.
 *
 * AskRegistry is pure so 14_vscode.sh can prove the merge and the count
 * under plain node; registerAskRegistry draws it: a status-bar count, the
 * agent view's badge, and a notification for anything that arrives where the
 * person is not looking, answerable from the notification itself. The Needs
 * view (task 6.2) reads the same registry. */

const KIND_ORDER = { acp: 0, approval: 1, ask: 2 };
const NOTIFY_BATCH_MS = 150;
const POLL_MS = 15000;       /* reload cadence only while serve is down */

function optionList(raw, recommended) {
    const list = Array.isArray(raw) ? raw : [];
    return list.map((o) => {
        const value = typeof o === 'string' ? o : String((o && (o.optionId || o.value || o.name)) || '');
        const label = typeof o === 'string' ? o : String((o && (o.name || o.label || o.optionId)) || value);
        return { label, value, recommended: !!recommended && value === recommended };
    }).filter((o) => o.value);
}

function askItem(row) {
    const r = row || {};
    return {
        key: `ask:${r.id}`, source: 'ask', id: r.id, askId: r.id,
        kind: r.kind || 'question', title: r.title || `Ask #${r.id}`,
        detail: r.body || '', task: r.task || '',
        blocking: !!r.blocking, overdue: !!r.overdue,
        state: r.state || 'open', recommended: r.recommended || '',
        options: optionList(r.options, r.recommended),
        raised: Number(r.raised) || 0, by: r.raised_by || '',
        deadline: r.deadline || null,
    };
}

function approvalItem(row) {
    const r = row || {};
    return {
        key: `approval:${r.id}`, source: 'approval', id: r.id,
        askId: r.ask || null, gate: r.gate || '', subject: r.subject || '',
        kind: 'permission', title: `${r.gate || '?'} of ${r.subject || '?'}`,
        detail: 'A fleet approval gate: approve lets it go ahead once; reject stops it.',
        task: r.subject || '', blocking: true, overdue: false, state: 'pending',
        recommended: '', options: [
            { label: 'Approve', value: 'approve', recommended: false },
            { label: 'Reject', value: 'reject', recommended: false }],
        raised: Number(r.requested) || 0, by: r.requested_by || r.by || '',
    };
}

class AskRegistry {
    constructor() {
        this.asks = new Map();        /* ask id -> item */
        this.approvals = new Map();   /* approval id -> item */
        this.permits = new Map();     /* `${session}:${pid}` -> item */
        this.seen = new Set();        /* keys already announced */
        this.journal = [];            /* recent events, to replay over a read */
        this.applied = 0;             /* events ever applied */
        this.listeners = [];
    }

    onChange(fn) {
        this.listeners.push(fn);
        return () => { const i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); };
    }

    _changed() {
        const fresh = this.items().filter((i) => !this.seen.has(i.key));
        for (const i of fresh) this.seen.add(i.key);
        for (const fn of this.listeners.slice()) { try { fn(fresh); } catch (_) { /* a view's bug */ } }
    }

    /* Taken before a full read starts: events that arrive while the read is
     * in flight may be newer than it, so the load replays them (each event
     * carries its row as it stands, so replay is idempotent). */
    mark() { return this.applied; }

    _replay(since) {
        if (since == null) return;
        const skip = this.journal.length - (this.applied - since);
        for (const e of this.journal.slice(Math.max(0, skip))) this._apply(e);
    }

    /* A full read (cg ask list --json, or the serve snapshot's asks array)
     * replaces what events built. null means the read failed: keep what is
     * known rather than empty the registry. */
    loadAsks(rows, since) {
        if (!Array.isArray(rows)) return false;
        this.asks.clear();
        for (const r of rows) if (r && r.id != null && r.state !== 'answered') this.asks.set(r.id, askItem(r));
        this._replay(since);
        this._changed();
        return true;
    }

    loadApprovals(rows, since) {
        if (!Array.isArray(rows)) return false;
        this.approvals.clear();
        for (const r of rows) if (r && r.id != null && r.state === 'pending') this.approvals.set(r.id, approvalItem(r));
        this._replay(since);
        this._changed();
        return true;
    }

    /* One pushed event; true when it changed the registry. */
    applyEvent(e) {
        if (!e || !/^(ask|approval)\./.test(e.kind || '')) return false;
        this.journal.push(e);
        if (this.journal.length > 500) this.journal.shift();
        this.applied++;
        if (!this._apply(e)) return false;
        this._changed();
        return true;
    }

    _apply(e) {
        const p = e.payload || {};
        if (e.kind === 'ask.raised' || e.kind === 'ask.expired' || e.kind === 'ask.answered') {
            if (p.id == null) return false;
            if (p.state === 'answered' || e.kind === 'ask.answered') return this.asks.delete(p.id);
            this.asks.set(p.id, askItem(p));
            return true;
        }
        if (e.kind === 'approval.request' && p.id != null && (p.state || 'pending') === 'pending') {
            this.approvals.set(p.id, approvalItem(p));
            return true;
        }
        if (e.kind === 'approval.decided' && p.id != null) return this.approvals.delete(p.id);
        return false;
    }

    /* An ACP permission card drawn in one chat surface. `answer(optionId)`
     * settles it in that surface (AgentPanel.answer); `inView()` says whether
     * the person can see its card right now. */
    addPermission(session, msg, hooks) {
        const m = msg || {};
        const h = hooks || {};
        const options = optionList(m.options);
        if (!options.length) return false;   /* AgentPanel answers these itself */
        const key = `acp:${session}:${m.pid}`;
        this.permits.set(`${session}:${m.pid}`, {
            key, source: 'acp', id: m.pid, session, kind: 'permission',
            title: m.title || 'Permission request',
            detail: [h.label ? `agent chat ${h.label}` : 'agent chat', m.kind].filter(Boolean).join(' · '),
            task: h.task || '', blocking: true, overdue: false, state: 'pending',
            recommended: '', options, raised: Math.floor(Date.now() / 1000), by: h.label || '',
            answer: h.answer, inView: h.inView,
        });
        this._changed();
        return true;
    }

    settlePermission(session, pid) {
        if (!this.permits.delete(`${session}:${pid}`)) return false;
        this._changed();
        return true;
    }

    dropSession(session) {
        let n = 0;
        for (const k of [...this.permits.keys()]) {
            if (k.startsWith(`${session}:`)) { this.permits.delete(k); n++; }
        }
        if (n) this._changed();
        return n;
    }

    /* The merged list: a durable Ask that is a fleet gate's permission Ask
     * folds into the approval (linked by cg fleet approvals' `ask`, or, from
     * events alone, by the title and task fleet_gate gives it). Blocking
     * first, then overdue, then by source and age. */
    items() {
        const linked = new Map();
        for (const ap of this.approvals.values()) {
            if (ap.askId != null) linked.set(ap.askId, ap);
        }
        const out = [...this.permits.values()];
        const approvals = [...this.approvals.values()].map((ap) => Object.assign({}, ap));
        for (const a of this.asks.values()) {
            let ap = linked.get(a.id);
            if (!ap && a.kind === 'permission') {
                ap = approvals.find((x) => x.askId == null && x.title === a.title && x.task === a.task);
            }
            if (ap) {
                const copy = approvals.find((x) => x.id === ap.id);
                if (copy) { copy.askId = a.id; copy.overdue = copy.overdue || a.overdue; }
                continue;
            }
            out.push(a);
        }
        out.push(...approvals);
        return out.sort((x, y) =>
            (y.blocking - x.blocking) || (y.overdue - x.overdue) ||
            (KIND_ORDER[x.source] - KIND_ORDER[y.source]) || (x.raised - y.raised) ||
            String(x.key).localeCompare(String(y.key)));
    }

    counts() {
        const all = this.items();
        return { open: all.length, blocking: all.filter((i) => i.blocking).length,
                 overdue: all.filter((i) => i.overdue).length };
    }

    find(key) { return this.items().find((i) => i.key === key) || null; }
}

/* What the status bar and the view badge say. Pure, so the test reads the
 * exact strings a person sees. */
function badgeOf(counts) {
    const c = counts || { open: 0, blocking: 0 };
    if (!c.open) return null;
    const tooltip = c.blocking
        ? `${c.blocking} blocking Ask${c.blocking === 1 ? '' : 's'} waiting on you` +
          (c.open > c.blocking ? `, ${c.open - c.blocking} more open` : '')
        : `${c.open} open Ask${c.open === 1 ? '' : 's'} (work continues on the recommended option)`;
    return { value: c.open, tooltip,
             text: c.blocking ? `$(bell-dot) ${c.blocking} blocking` + (c.open > c.blocking ? ` · ${c.open}` : '')
                              : `$(bell) ${c.open}` };
}

function describe(item) {
    const where = item.task ? ` [${item.task}]` : '';
    const src = item.source === 'acp' ? 'Agent asks' : item.source === 'approval' ? `Approval #${item.id}` : `Ask #${item.id} (${item.kind})`;
    return `${src}${where}: ${item.title}`;
}

/* ---------------- the editor surface ---------------- */

const ANSWER_COMMAND = 'codify.asks.answer';

/* d: { cg, cgJson, events: {available}, setBadge(badge|null), focusView() } */
function registerAskRegistry(ctx, d) {
    const vscode = require('vscode');
    const registry = new AskRegistry();
    const deps = d || {};
    let bar = null;
    if (typeof vscode.window.createStatusBarItem === 'function') {
        bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment
            ? vscode.StatusBarAlignment.Left : 1, 48);
        bar.command = ANSWER_COMMAND;
        ctx.subscriptions.push(bar);
    }

    function paint() {
        const b = badgeOf(registry.counts());
        if (deps.setBadge) deps.setBadge(b);
        if (!bar) return;
        if (!b) { bar.hide(); return; }
        bar.text = b.text;
        bar.tooltip = `${b.tooltip} — click to answer`;
        bar.backgroundColor = registry.counts().blocking && vscode.ThemeColor
            ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
        bar.show();
    }

    async function reload() {
        if (!deps.cgJson) return;
        const since = registry.mark();
        const [a, f] = await Promise.all([
            deps.cgJson(['ask', 'list']).catch(() => null),
            deps.cgJson(['fleet', 'approvals']).catch(() => null)]);
        registry.loadApprovals(f && f.approvals, since);
        registry.loadAsks(a && a.asks, since);
    }

    /* Settle one item with one value; true when it is settled. */
    async function settle(item, value) {
        if (item.source === 'acp') {
            return !!(item.answer && item.answer(value));
        }
        const args = item.source === 'approval'
            ? ['fleet', 'approve', String(item.id), ...(value === 'reject' ? ['--reject'] : [])]
            : ['ask', 'answer', String(item.id), String(value)];
        const r = await deps.cg(args);
        if (r.code !== 0) {
            vscode.window.showErrorMessage(`Hyperfide: ${describe(item)} — ${String(r.stderr || r.stdout || 'failed').trim().split('\n')[0]}`);
            return false;
        }
        await reload();
        if (deps.refresh) deps.refresh();
        return true;
    }

    /* The answer for one item, picked in the editor. */
    async function pickAnswer(item) {
        if (item.options.length) {
            const picks = item.options.slice().sort((x, y) => y.recommended - x.recommended)
                .map((o) => ({ label: o.label, value: o.value,
                    description: o.recommended ? 'recommended' : '' }));
            const p = await vscode.window.showQuickPick(picks, {
                placeHolder: describe(item), ignoreFocusOut: true });
            return p ? p.value : undefined;
        }
        const secret = item.kind === 'secret';
        return vscode.window.showInputBox({
            prompt: describe(item) + (item.detail ? ` — ${item.detail}` : ''),
            placeHolder: secret ? 'secret-ref:<id> — a reference, never the value' : 'your answer',
            ignoreFocusOut: true,
            validateInput: (v) => !String(v || '').trim() ? 'an answer is required'
                : secret && !/^secret-ref:/.test(v.trim()) ? 'answer a secret with secret-ref:<id>' : null,
        }).then((v) => v === undefined ? undefined : v.trim());
    }

    async function answerItem(item) {
        const v = await pickAnswer(item);
        if (v === undefined || v === '') return false;
        return settle(item, v);
    }

    /* The palette / status-bar entry: every open item, blocking first. */
    async function answerFlow(key) {
        let item = typeof key === 'string' ? registry.find(key) : null;
        if (!item) {
            const all = registry.items();
            if (!all.length) { vscode.window.showInformationMessage('Hyperfide: nothing is waiting on you.'); return; }
            const p = await vscode.window.showQuickPick(all.map((i) => ({
                label: `${i.blocking ? '$(error) ' : '$(info) '}${i.title}`,
                description: [i.source === 'acp' ? 'agent chat' : i.source === 'approval' ? `approval #${i.id}` : `${i.kind} #${i.id}`,
                              i.task, i.overdue ? 'overdue' : ''].filter(Boolean).join(' · '),
                detail: i.detail || undefined, key: i.key })),
            { placeHolder: 'Answer which Ask?', ignoreFocusOut: true });
            if (!p) return;
            item = registry.find(p.key);
        }
        if (item) await answerItem(item);
    }

    /* Out-of-view: anything new whose card the person cannot see now gets a
     * notification whose buttons answer it. Arrivals are batched so a reload
     * with ten open Asks is one notification, not ten. */
    let pending = [];
    let timer = null;
    function announce(fresh) {
        pending.push(...fresh.filter((i) => !(i.inView ? i.inView() : deps.inView && deps.inView(i))));
        if (!pending.length || timer) return;
        timer = setTimeout(flush, NOTIFY_BATCH_MS);
    }
    async function flush() {
        timer = null;
        const batch = pending.filter((i) => registry.find(i.key));
        pending = [];
        if (!batch.length) return;
        const blocking = batch.some((i) => i.blocking);
        const show = blocking ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
        if (batch.length > 1) {
            const n = batch.filter((i) => i.blocking).length;
            const pick = await show(`Hyperfide: ${batch.length} Asks waiting${n ? ` (${n} blocking)` : ''}.`, 'Answer…');
            if (pick) await answerFlow();
            return;
        }
        const item = batch[0];
        const buttons = item.options.length && item.options.length <= 3
            ? item.options.map((o) => o.recommended ? `${o.label} (recommended)` : o.label) : ['Answer…'];
        const pick = await show(`Hyperfide: ${describe(item)}`, ...buttons);
        if (!pick) return;
        const live = registry.find(item.key);
        if (!live) return;
        const opt = live.options.find((o) => pick === o.label || pick === `${o.label} (recommended)`);
        if (opt) await settle(live, opt.value);
        else await answerItem(live);
    }

    registry.onChange((fresh) => { paint(); if (fresh.length) announce(fresh); });
    ctx.subscriptions.push(vscode.commands.registerCommand(ANSWER_COMMAND, answerFlow));
    const poll = setInterval(() => {
        if (!(deps.events && deps.events.available())) reload();
    }, POLL_MS);
    if (poll.unref) poll.unref();
    ctx.subscriptions.push({ dispose: () => { clearInterval(poll); if (timer) clearTimeout(timer); } });
    paint();
    return { registry, reload, settle, answer: answerFlow, paint };
}

/* ================================================================
 * The Needs view (hyperfide-v21 6.2) — what a person owes the run.
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
 * The view keeps its own reads rather than the registry's items because it
 * needs what askItem drops (default policy, state version, run) to show the
 * policy and settle through the routed verb (D11). It redraws when the
 * registry above changes; fleet approvals and ACP permission cards stay with
 * codify.asks.answer.
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
const REGISTRY_REDRAW_MS = 250;
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

/* d: { cg, cgJson, workspaceRoot, registry? } — registry is the 6.1
 * AskRegistry; any change to it redraws this view (coalesced). */
function register(ctx, d) {
    view = new NeedsView(d);
    const tv = vscode.window.createTreeView('codifyNeeds', { treeDataProvider: view, showCollapseAll: true });
    view.view = tv;
    view.visible = tv.visible;
    ctx.subscriptions.push(tv, tv.onDidChangeVisibility((e) => {
        view.visible = e.visible;
        if (e.visible) { view.force = true; view.refresh(); }
    }));
    if (d.registry && typeof d.registry.onChange === 'function') {
        let timer = null;
        const off = d.registry.onChange(() => {
            view.force = true;
            if (timer) return;
            timer = setTimeout(() => { timer = null; view.refresh(); }, REGISTRY_REDRAW_MS);
        });
        ctx.subscriptions.push({ dispose: () => { off(); if (timer) clearTimeout(timer); } });
    }
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

module.exports = { AskRegistry, badgeOf, describe, registerAskRegistry, ANSWER_COMMAND,
                   register, NeedsView, needsModel, answerPlan, answerCommand, consolePanel,
                   localAsks, validateSecret, CONSOLE_ARGS, LOCAL_ARGS };
