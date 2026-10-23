// Shared toolkit layer: fleet.json, the five HF_* credentials (never printed, redacted from every captured output),
// the Railway SDK connection, exec helpers, the base bundle and the JSON ledgers. Adapted from the Paxeer sandbox fleet.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
process.umask(0o077);

export const here = path.dirname(fileURLToPath(import.meta.url));
// HF_FLEET_CONFIG points the toolkit at another fleet.json (the 96 suite does); relative paths resolve against its directory.
export const cfgFile = path.resolve(process.env.HF_FLEET_CONFIG || path.join(here, 'fleet.json'));
export const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
const cfgDir = path.dirname(cfgFile);
export const P = Object.fromEntries(Object.entries(cfg.paths).map(([k, v]) => [k, path.resolve(cfgDir, v)]));
export const W = cfg.workspace;

export const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20}).trim();
export const tryGit = (dir, ...a) => { try { return git(dir, ...a); } catch { return null; } };
// The main working tree, never GitHub: a worktree of the repository resolves to the checkout that owns the object store.
export const repoRoot = cfg.repo ? path.resolve(cfgDir, cfg.repo)
  : path.dirname(git(cfgDir, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
export const mainTip = () => git(repoRoot, 'rev-parse', '--verify', `refs/heads/${cfg.mainBranch}^{commit}`);
export const isAncestor = (a, b) => tryGit(repoRoot, 'merge-base', '--is-ancestor', a, b) !== null;

const E = cfg.env;
export const ALL_ENV = [E.token, E.environmentId, E.gatewayUrl, E.gatewayKeys];
export function requireEnv(names = ALL_ENV) {
  const missing = names.filter(n => !(process.env[n] || '').trim());
  if (missing.length) { console.error(`refusing to start: environment variable(s) not set: ${missing.join(', ')}`); process.exit(2); }
}
export const gatewayKeys = () => (process.env[E.gatewayKeys] || '').split(',').map(s => s.trim()).filter(Boolean);
export const gatewayModel = () => (process.env[E.gatewayModel] || '').trim() || cfg.defaultModel;
const secrets = () => [E.token, E.environmentId, E.gatewayUrl].map(n => (process.env[n] || '').trim())
  .concat(gatewayKeys()).filter(s => s.length >= 8).sort((a, b) => b.length - a.length);
const TOKENISH = [/\b(?:sk|rk|pk|ghp|gho|ghs|github_pat|xox[bap])[-_][A-Za-z0-9_-]{12,}/g, /(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{12,}/gi,
  /\b[A-Za-z0-9+\/_-]{24,}\.[A-Za-z0-9+\/_-]{24,}\.[A-Za-z0-9+\/_-]{16,}\b/g];
export const redact = v => { let s = String(v ?? ''); for (const k of secrets()) s = s.split(k).join('[REDACTED]'); for (const re of TOKENISH) s = s.replace(re, '[REDACTED]'); return s; };

// Lazy so collect, status and the dry dispatch run without the SDK installed.
export async function sdk() {
  const {Sandbox, SandboxNotFoundError} = await import('railway');
  const {default: WebSocket} = await import('ws');
  class RailwayWebSocket extends WebSocket { constructor(url, protocols) { super(url, protocols, {origin: 'https://railway.com'}); } }
  const config = {token: process.env[E.token].trim(), authType: 'bearer', environmentId: process.env[E.environmentId].trim(), webSocketImpl: RailwayWebSocket};
  return {Sandbox, SandboxNotFoundError, config};
}

export const now = () => new Date().toISOString();
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const sq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const safe = id => String(id).replace(/[^0-9A-Za-z._-]/g, '_');
export const fill = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
export function save(p, d) {
  fs.mkdirSync(path.dirname(p), {recursive: true, mode: 0o700});
  const t = `${p}.${randomUUID()}`; fs.writeFileSync(t, JSON.stringify(d, null, 2) + '\n', {mode: 0o600}); fs.renameSync(t, p);
}
export const load = p => JSON.parse(fs.readFileSync(p, 'utf8'));
export function writePrivate(p, data) { fs.mkdirSync(path.dirname(p), {recursive: true, mode: 0o700}); fs.writeFileSync(p, data, {mode: 0o600}); return p; }

export const ledgerPath = id => path.join(P.ledger, 'jobs', `${safe(id)}.json`);
export const failedPath = id => path.join(P.ledger, 'failed', `${safe(id)}.json`);
export const findLedger = id => [ledgerPath(id), failedPath(id)].find(f => fs.existsSync(f)) || null;
export function poolWorkers() {
  const dir = path.join(P.ledger, 'pool'); if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => ({file: path.join(dir, f), ...load(path.join(dir, f))}));
}
export function updateWorker(file, patch) { const {file: _f, ...rec} = load(file); save(file, {...rec, ...patch}); }
// One gateway key per sandbox, chosen by the worker's number, so load spreads across the keys.
export function keyFor(workerName) {
  const keys = gatewayKeys(); if (!keys.length) throw new Error(`${E.gatewayKeys} holds no key`);
  const n = Number((String(workerName).match(/(\d+)$/) || [0, 0])[1]); return keys[n % keys.length];
}

export function shell(command, cwd) { return `${cfg.shellPrefix || ''}${cwd ? `cd ${sq(cwd)} && ` : ''}${command}`; }
export async function run(sb, command, {timeoutSec = 1800, label = '', cwd} = {}) {
  const started = Date.now();
  const r = await sb.exec(shell(command, cwd), {timeoutSec, maxOutputBytes: 4_000_000}).result();
  return {label, exitCode: r.exitCode, timedOut: r.timedOut, truncated: r.truncated, ms: Date.now() - started, stdout: redact(r.stdout), stderr: redact(r.stderr)};
}
export async function must(sb, command, opts = {}) {
  const r = await run(sb, command, opts);
  if (r.exitCode !== 0 || r.timedOut) {
    const e = new Error(`[${opts.label || command.slice(0, 60)}] exit=${r.exitCode} timedOut=${r.timedOut}\n--stdout--\n${r.stdout.slice(-3000)}\n--stderr--\n${r.stderr.slice(-3000)}`);
    e.result = r; throw e;
  }
  return r;
}
export async function readBytes(sb, p) { return Buffer.from(await sb.files.read(p, {format: 'bytes'})); }

// What a worker lacks above the checkpoint: refs/heads/main ^<checkpointCommit>, built once per main tip. The file appears
// by rename, so concurrent runners never see a half-written bundle and never wait on a lock.
export function baseBundle(baseCommit) {
  const cp = cfg.checkpointCommit;
  if (!cp) throw new Error('fleet.json has no checkpointCommit: run `provision.mjs base` or `provision.mjs use` first');
  if (isAncestor(baseCommit, cp)) return null;
  const tip = mainTip();
  if (!isAncestor(baseCommit, tip)) throw new Error(`base ${baseCommit} is not reachable from local ${cfg.mainBranch}`);
  const file = path.join(P.bundles, `base-${tip.slice(0, 12)}.bundle`);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(P.bundles, {recursive: true, mode: 0o700});
  const tmp = `${file}.${randomUUID()}.tmp`;
  git(repoRoot, 'bundle', 'create', '-q', tmp, `refs/heads/${cfg.mainBranch}`, `^${cp}`);
  fs.renameSync(tmp, file);
  return file;
}
// Record the checkpoint in fleet.json (the one place the toolkit reads it from).
export function recordCheckpoint(name, commit) {
  const c = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); c.checkpoint = name; c.checkpointCommit = commit;
  const t = `${cfgFile}.${randomUUID()}`; fs.writeFileSync(t, JSON.stringify(c, null, 2) + '\n'); fs.chmodSync(t, 0o644); fs.renameSync(t, cfgFile);
}
export function opts(argv, flags = []) {
  const o = {_: []};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (flags.includes(k)) o[k] = true; else o[k] = argv[++i];
  }
  return o;
}
