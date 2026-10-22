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

module.exports = { AskRegistry, badgeOf, describe, registerAskRegistry, ANSWER_COMMAND };
