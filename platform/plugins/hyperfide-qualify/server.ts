import { runBinary, runTaskThread, type Runner, type RunTaskHost } from "../hyperfide-spec/projection-run-task";
import { WavePublication, type PublicationHost } from "./publication";
import { waveDetail } from "../hyperfide-spec/wave-detail";
import type { HumanJob, Operator } from "../hyperfide-spec/closure-projection";

export interface ImplementedTask {
  id: string; status: string; wave: number; cwd: string; base: string;
  criteria: string[]; verifyCmd: string; laneLog: string; workerProvider: string;
  touches: string[]; reqs: string[];
}
export interface Finding { file: string; line: number; severity: string; claim: string }
export interface Verdict {
  verdict: "pass" | "findings"; findings: Finding[]; verify: { cmd: string; exit: number };
}
export interface CheckerRecord {
  status: "pass" | "findings" | "error"; independent: boolean;
  provider: string; verdict?: Verdict; fixTasks: string[]; error?: string;
}
export interface CheckerHost extends RunTaskHost {
  onImplemented(handler: (task: ImplementedTask) => Promise<CheckerRecord | undefined>): void;
  recordChecker(task: string, record: CheckerRecord): Promise<void>;
  listTaskIds(cwd: string): Promise<string[]>;
}
export interface CheckerConfig { providers: string[]; checkerProvider?: string; binary?: string; runner?: Runner }

function parseVerdict(value: unknown, task: ImplementedTask, exits: number[]): Verdict {
  const v = value as Verdict;
  if (!v || !["pass", "findings"].includes(v.verdict) || !Array.isArray(v.findings)
    || !v.verify || v.verify.cmd !== task.verifyCmd || !exits.includes(v.verify.exit)
    || exits.length === 0 || v.verify.exit !== exits.at(-1)
    || (v.verdict === "pass" && (v.verify.exit !== 0 || v.findings.length !== 0))
    || (v.verdict === "findings" && v.findings.length === 0)) throw new Error("Invalid checker verdict or missing verify run");
  for (const f of v.findings) {
    if (!f || typeof f.file !== "string" || !f.file.trim() || !Number.isInteger(f.line) || f.line < 1
      || typeof f.severity !== "string" || !f.severity.trim() || typeof f.claim !== "string" || !f.claim.trim()) {
      throw new Error("Invalid checker finding");
    }
  }
  return v;
}

export function registerChecker(host: CheckerHost, config: CheckerConfig) {
  const runner = config.runner ?? runBinary;
  const active = new Map<string, Promise<CheckerRecord | undefined>>();
  const repositories = new Map<string, Promise<unknown>>();
  const check = async (task: ImplementedTask): Promise<CheckerRecord | undefined> => {
    if (task.status !== "implemented") return;
    const provider = (config.checkerProvider && config.checkerProvider !== task.workerProvider
      ? config.checkerProvider : config.providers.find(p => p !== task.workerProvider)) ?? config.providers[0];
    const record: CheckerRecord = { status: "error", independent: !!provider && provider !== task.workerProvider,
      provider: provider ?? "", fixTasks: [] };
    try {
      if (!provider || !config.providers.includes(provider)) throw new Error("Checker provider is not configured");
      const diff = await runner("git", ["diff", task.base, "--"], task.cwd);
      if (diff.exit !== 0) throw new Error(diff.stderr || "Cannot read checker diff");
      const exits: number[] = [];
      const verdict = parseVerdict(await runTaskThread(host, {
        task: task.id, provider, cwd: task.cwd, role: "checker",
        packet: JSON.stringify({ criteria: task.criteria, diff: diff.stdout, laneLog: task.laneLog,
          verifyCmd: task.verifyCmd, instruction: "Run the verify tool yourself, then return {verdict: pass|findings, findings: [{file,line,severity,claim}], verify: {cmd,exit}}." }),
      }, { verify: async () => {
        const result = await runner("bash", ["-lc", task.verifyCmd], task.cwd);
        exits.push(result.exit);
        return result;
      } }), task, exits);
      record.verdict = verdict;
      const ids = new Set(await host.listTaskIds(task.cwd));
      for (const finding of verdict.findings) {
        let next = 1;
        while (ids.has(`${task.wave}.${next}`)) next++;
        const id = `${task.wave}.${next}`;
        const result = await runner(config.binary ?? "hyperfide", ["spec", "add", id,
          "--title", `Checker ${finding.severity}: ${finding.claim}`, "--wave", String(task.wave),
          "--requires", task.id, "--touches", finding.file, "--verify", task.verifyCmd,
          "--do", `${finding.file}:${finding.line} [${finding.severity}] ${finding.claim}`,
          "--reqs", task.reqs.join(",")], task.cwd);
        if (result.exit !== 0) throw new Error(result.stderr || "Cannot append checker fix task");
        ids.add(id); record.fixTasks.push(id);
      }
      record.status = verdict.verdict;
    } catch (error) { record.error = String(error); }
    await host.recordChecker(task.id, record);
    return record;
  };
  const handle = (task: ImplementedTask) => {
    // Coalesce repeated lifecycle notifications while a checker is running.
    const key = `${task.cwd}:${task.id}`;
    if (!active.has(key)) {
      // Serialize each repository so concurrent verdicts cannot allocate the same fix id.
      const previous = repositories.get(task.cwd) ?? Promise.resolve();
      const pending = previous.catch(() => {}).then(() => check(task)).finally(() => {
        active.delete(key);
        if (repositories.get(task.cwd) === pending) repositories.delete(task.cwd);
      });
      repositories.set(task.cwd, pending);
      active.set(key, pending);
    }
    return active.get(key)!;
  };
  host.onImplemented(handle);
  return handle;
}

// ---- Wave closure and publication (task 4.4)
// Projection host adapter: the real plugin host supplies authority, Asks and storage.
export interface ClosurePluginHost extends PublicationHost {
  operator(): Promise<Operator>;
  rpc: {
    register(name: string, handler: (input: any) => Promise<unknown>): void;
  };
}
export default function registerWaveClosure(host: ClosurePluginHost) {
  const detail = waveDetail(host.authority);
  const publication = new WavePublication(host);
  host.rpc.register(
    "hyperfide-qualify.wave",
    (input: { feature: string; wave: number }) =>
      detail.read(input.feature, input.wave),
  );
  host.rpc.register(
    "hyperfide-qualify.mark",
    async (input: { feature: string; wave: number; job: HumanJob }) =>
      detail.mark(input.feature, input.wave, input.job, await host.operator()),
  );
  host.rpc.register("hyperfide-qualify.prepare", (input) =>
    publication.prepare(input),
  );
  host.rpc.register(
    "hyperfide-qualify.publish",
    (input: { feature: string; wave: number }) =>
      publication.publish(input.feature, input.wave),
  );
  return publication;
}
