#!/usr/bin/env node
/* Fake ACP agent for task 6.9 (14_vscode.sh acpbridge): demands sign-in
 * through an env_var auth method, then drives the client's terminal/*
 * bridge and reports what it saw as one JSON agent message.
 *
 * Env knobs:
 *   BRIDGE_ACP_LOG    append every received request as {method, params} (jsonl)
 *   BRIDGE_ACP_OUTSIDE  an absolute directory outside the workspace, used as a
 *                     terminal cwd the client must refuse
 * The credential variable is FAKE_ACP_TOKEN; its value is never echoed. */
'use strict';

const fs = require('fs');

let buf = '';
let nextId = 5000;
const waiting = new Map();
let authed = false;
let clientCaps = {};

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }
function update(sessionId, u) {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
}

/* resolves {result} or {error} so the agent can test refusals */
function request(method, params) {
    return new Promise((resolve) => {
        const id = nextId++;
        waiting.set(id, resolve);
        send({ jsonrpc: '2.0', id, method, params });
    });
}

function log(method, params) {
    if (!process.env.BRIDGE_ACP_LOG) return;
    fs.appendFileSync(process.env.BRIDGE_ACP_LOG, JSON.stringify({ method, params }) + '\n');
}

async function terminalRun(sid, create) {
    const made = await request('terminal/create', Object.assign({ sessionId: sid }, create));
    if (made.error) return { error: made.error };
    const terminalId = made.result.terminalId;
    const exit = await request('terminal/wait_for_exit', { sessionId: sid, terminalId });
    const out = await request('terminal/output', { sessionId: sid, terminalId });
    const rel = await request('terminal/release', { sessionId: sid, terminalId });
    const after = await request('terminal/output', { sessionId: sid, terminalId });
    return { exit: exit.result, output: out.result, released: rel.error ? rel.error : 'ok',
        afterRelease: after.error ? after.error.code : 'still there' };
}

async function promptTurn(id, params) {
    const sid = params.sessionId;
    const report = { blocks: (params.prompt || []).map((b) => b.type) };
    const res = (params.prompt || []).find((b) => b.type === 'resource' || b.type === 'resource_link');
    if (res) report.context = res;
    report.terminalCap = !!clientCaps.terminal;

    /* argv form, non-zero exit */
    report.argv = await terminalRun(sid, { command: process.execPath,
        args: ['-e', 'console.log("bridge out"); console.error("bridge err"); process.exit(3)'] });
    /* shell line with an env var the agent supplies */
    report.shell = await terminalRun(sid, { command: 'echo "v=$BRIDGE_VAR"',
        env: [{ name: 'BRIDGE_VAR', value: 'from-agent' }] });
    /* output bounded on a character boundary */
    report.bounded = await terminalRun(sid, { command: process.execPath,
        args: ['-e', 'process.stdout.write("é".repeat(50) + "tail")'], outputByteLimit: 11 });
    /* kill keeps the terminal readable; the exit carries the signal */
    const long = await request('terminal/create', { sessionId: sid, command: process.execPath,
        args: ['-e', 'console.log("started"); setInterval(() => {}, 1000)'] });
    const tid = long.result.terminalId;
    for (let i = 0; i < 200; i++) {
        const o = await request('terminal/output', { sessionId: sid, terminalId: tid });
        if (/started/.test(o.result.output)) break;
        await new Promise((r) => setTimeout(r, 50));
    }
    await request('terminal/kill', { sessionId: sid, terminalId: tid });
    const killed = await request('terminal/wait_for_exit', { sessionId: sid, terminalId: tid });
    const killedOut = await request('terminal/output', { sessionId: sid, terminalId: tid });
    await request('terminal/release', { sessionId: sid, terminalId: tid });
    report.killed = { exit: killed.result, output: killedOut.result };
    /* refusals */
    report.outside = await terminalRun(sid, { command: 'true',
        cwd: process.env.BRIDGE_ACP_OUTSIDE || '/' });
    report.unknown = (await request('terminal/output', { sessionId: sid, terminalId: 'term-999' })).error;
    report.noCommand = (await request('terminal/create', { sessionId: sid })).error;

    update(sid, { sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: JSON.stringify(report) } });
    reply(id, { stopReason: 'end_turn' });
}

function dispatch(msg) {
    if (msg.method === undefined && msg.id !== undefined) {
        const r = waiting.get(msg.id);
        if (r) { waiting.delete(msg.id); r({ result: msg.result, error: msg.error }); }
        return;
    }
    log(msg.method, msg.params);
    switch (msg.method) {
    case 'initialize':
        clientCaps = (msg.params && msg.params.clientCapabilities) || {};
        reply(msg.id, {
            protocolVersion: 1,
            agentInfo: { name: 'bridge-agent', version: '0.0.1' },
            agentCapabilities: { promptCapabilities: { embeddedContext: true } },
            authMethods: [
                { id: 'fake-key', name: 'Fake key', type: 'env_var', varName: 'FAKE_ACP_TOKEN' },
                { id: 'fake-browser', name: 'Fake browser' },
            ],
        });
        break;
    case 'authenticate':
        if (msg.params && msg.params.methodId === 'fake-key' && process.env.FAKE_ACP_TOKEN) {
            authed = true;
            reply(msg.id, {});
        } else {
            fail(msg.id, -32000, 'Authentication required');
        }
        break;
    case 'session/new':
        if (!authed) { fail(msg.id, -32000, 'Authentication required'); break; }
        reply(msg.id, { sessionId: 'bridge-1' });
        break;
    case 'session/prompt':
        promptTurn(msg.id, msg.params);
        break;
    default:
        if (msg.id !== undefined) fail(msg.id, -32601, `unknown method ${msg.method}`);
    }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) dispatch(JSON.parse(line));
    }
});
process.stdin.on('end', () => process.exit(0));
