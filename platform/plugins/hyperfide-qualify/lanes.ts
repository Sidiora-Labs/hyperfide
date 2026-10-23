import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createQualificationAdapter, runBinary, type QualificationAdapter } from './adapter';
import { writeReceipt } from './receipts';
import { openQualifyStorage } from './storage';
export type LaneState = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled';
export interface StartLane { repository: string; feature: string; task: string; mode?: 'verify' | 'done'; postgres?: boolean; busyTimeoutMs?: number }
export interface Lane {
  id: string; repository: string; feature: string; task: string; mode: 'verify' | 'done'; command: string; state: LaneState;
  commit: string | null; environmentId: string | null; environmentPath: string | null;
  toolchain: {node: string | null; pnpm: string | null; hyperfide: string | null};
  exitCode: number | null; signal: string | null; durationMs: number | null; error: string | null; busyTimeoutMs: number;
  receipt?: string;
  verifyCmd: string;
}
export interface LogEntry { sequence: number; stream: 'stdout' | 'stderr'; text: string }
export interface LaneEvent { lane: Lane; log?: LogEntry }
interface Job { lane: Lane; cancelled: boolean; child?: ChildProcess; completion: Promise<void>; finish(): void }
// Common Git directories unify linked worktrees and separate service instances.
const queues = new Map<string, Promise<void>>();
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
function kill(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
export class LaneService {
  private jobs = new Map<string, Job>();
  private logs = new Map<string, LogEntry[]>();
  private closed = false;
  constructor(private adapter: QualificationAdapter = createQualificationAdapter(), private publish: (event: LaneEvent) => void = () => {}) {}
  get(id: string): Lane { const job = this.jobs.get(id); if (!job) throw new Error(`Unknown lane ${id}`); return structuredClone(job.lane); }
  list(repository?: string) { return [...this.jobs.keys()].map(id => this.get(id)).filter(l => !repository || l.repository === repository); }
  log(id: string, after = 0) { this.get(id); return structuredClone(this.logs.get(id)!.filter(e => e.sequence > after)); }
  private emit(job: Job, log?: LogEntry) { try { this.publish({lane: this.get(job.lane.id), ...(log ? {log} : {})}); } catch {} }
  async start(input: StartLane) {
    if (this.closed) throw new Error('Qualification service is closed');
    const busyTimeoutMs = input.busyTimeoutMs ?? 120000;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1) throw new Error('Invalid busy timeout');
    const key = await this.adapter.repositoryKey(input.repository);
    const task = await this.adapter.task(input.repository, input.feature, input.task);
    if (this.closed) throw new Error('Qualification service is closed');
    const mode = input.mode ?? 'verify';
    const command = mode === 'done' ? `${quote(this.adapter.binary)} spec done ${quote(input.task)}` : task.verify_cmd;
    const lane: Lane = {...input, id: randomUUID(), mode, busyTimeoutMs, verifyCmd: task.verify_cmd,
      command: input.postgres ? `python3 tests/hyperfide/support/withpg.py -- sh -c ${quote(command)}` : command,
      state: 'queued', commit: null, environmentId: null, environmentPath: null,
      toolchain: {node: null, pnpm: null, hyperfide: null}, exitCode: null, signal: null, durationMs: null, error: null};
    let finish!: () => void;
    const completion = new Promise<void>(resolve => { finish = resolve; });
    const job: Job = {lane, completion, finish, cancelled: false};
    this.jobs.set(lane.id, job); this.logs.set(lane.id, []); this.emit(job);
    if (mode === 'done') {
      const pending = (queues.get(key) ?? Promise.resolve()).then(() => this.execute(job));
      queues.set(key, pending);
      void pending.finally(() => { if (queues.get(key) === pending) queues.delete(key); });
    } else void this.execute(job);
    return this.get(lane.id);
  }
  async cancel(id: string) {
    const lane = this.get(id), job = this.jobs.get(id)!;
    if (!['queued', 'running'].includes(lane.state)) return lane;
    job.cancelled = true;
    if (job.child) kill(job.child, 'SIGTERM');
    if (lane.state === 'queued') { job.lane.state = 'cancelled'; job.lane.durationMs = 0; job.finish(); this.emit(job); }
    else await job.completion;
    return this.get(id);
  }
  async wait(id: string) { this.get(id); await this.jobs.get(id)!.completion; return this.get(id); }
  async close() { this.closed = true; await Promise.all([...this.jobs.keys()].map(id => this.cancel(id))); }
  private async execute(job: Job) {
    if (job.cancelled) return;
    const lane = job.lane, started = performance.now();
    lane.state = 'running'; this.emit(job);
    let environment: Awaited<ReturnType<QualificationAdapter['environment']>> | undefined;
    try {
      environment = await this.adapter.environment(lane.repository, lane.id);
      lane.environmentId = environment.id; lane.environmentPath = environment.path;
      const options = {cwd: environment.path, env: {...environment.variables, CG_BUSY_TIMEOUT_MS: String(lane.busyTimeoutMs), CG_FEATURE: lane.feature}, timeout: 15000};
      lane.commit = (await runBinary('git', ['rev-parse', 'HEAD'], options)).stdout.trim();
      const version = async (binary: string) => { try { return (await runBinary(binary, ['--version'], options)).stdout.trim(); } catch { return null; } };
      [lane.toolchain.node, lane.toolchain.pnpm, lane.toolchain.hyperfide] = await Promise.all([version('node'), version('pnpm'), version(this.adapter.binary)]);
      if (!lane.toolchain.node?.startsWith('v24.') || lane.toolchain.pnpm !== '9.15.0') throw new Error('Qualification requires pinned Node 24 and pnpm 9.15.0');
      if (job.cancelled) return;
      this.emit(job);
      await new Promise<void>((resolve, reject) => {
        const child = spawn('sh', ['-c', lane.command], {...options, timeout: undefined, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
        job.child = child;
        // Descendants may ignore TERM even after their parent shell exits.
        const escalation = setInterval(() => { if (job.cancelled) kill(child, 'SIGKILL'); }, 250);
        for (const stream of ['stdout', 'stderr'] as const) {
          child[stream]!.setEncoding('utf8');
          child[stream]!.on('data', (text: string) => { const entries = this.logs.get(lane.id)!; const entry = {sequence: entries.length + 1, stream, text}; entries.push(entry); this.emit(job, entry); });
        }
        child.once('error', error => { clearInterval(escalation); reject(error); });
        child.once('close', (code, signal) => { if (job.cancelled) kill(child, 'SIGKILL'); clearInterval(escalation); lane.exitCode = code; lane.signal = signal; resolve(); });
      });
      lane.state = lane.exitCode === 0 ? 'passed' : 'failed';
      if (lane.state === 'passed' && !job.cancelled) {
        // Pin the executed tree before releasing it; retain evidence in the source repository.
        const tracked = await runBinary('git', ['ls-files', '-z'], options);
        const sources = tracked.stdout.split('\0').filter(path => path &&
          !path.split('/').some(part => part === '.env' || part.startsWith('.env.')) &&
          !path.startsWith('artifacts/'));
        const result = await writeReceipt({ task: lane.task, cwd: lane.repository,
          sourceRoot: environment.path, commit: lane.commit!, verify_cmd: lane.verifyCmd,
          exit: lane.exitCode!, duration: performance.now() - started,
          toolchain: Object.fromEntries(Object.entries(lane.toolchain).filter((entry): entry is [string, string] => entry[1] !== null)),
          log: this.logs.get(lane.id)!.map(entry => entry.text).join(''),
          sources });
        if (result) {
          lane.receipt = result.path;
          const storage = await openQualifyStorage(lane.repository);
          try { await storage.put('receipt:' + result.path, result.receipt); }
          finally { storage.close(); }
        }
      }
    } catch (error) { lane.error = error instanceof Error ? error.message : String(error); lane.state = 'failed'; }
    finally {
      try { await environment?.release(); } catch (error) { lane.error = `Environment cleanup failed: ${String(error)}`; lane.state = 'failed'; }
      if (job.cancelled) lane.state = 'cancelled';
      lane.durationMs = Math.round(performance.now() - started); this.emit(job); job.finish();
    }
  }
}
