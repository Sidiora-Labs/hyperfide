import { runBinary, type Runner } from "../hyperfide-spec/src/execution";
import { readWorkerTask, spawnTaskThread, type TaskWorkerHost, type WorkerTaskUpdate } from "../hyperfide-spec/src/worker";
import { featureFromKvx } from "../hyperfide-spec/src/kvx";
import type { Task } from "../hyperfide-spec/src/shared/model";
import { WavePublication, type PublicationHost } from "./publication";
import { waveDetail } from "../hyperfide-spec/wave-detail";
import type { HumanJob, Operator } from "../hyperfide-spec/wave-authority";

export interface Finding { file: string; line: number; severity: string; claim: string }
export interface Verdict {
  verdict: "pass" | "findings"; findings: Finding[]; verify: { cmd: string; exit: number };
}
export interface CheckerRecord {
  status: "pass" | "findings" | "error"; independent: boolean;
  provider: string; verdict?: Verdict; fixTasks: string[]; error?: string;
}
export interface CheckerConfig {
  providers: string[]; checkerProvider?: string; binary?: string; runner?: Runner;
  laneLog(update: WorkerTaskUpdate): Promise<string>;
  recordChecker(task: string, record: CheckerRecord): Promise<void>;
}

function parseVerdict(value: unknown, task: Task, exits: number[]): Verdict {
  const v = value as Verdict;
  if (!v || !["pass", "findings"].includes(v.verdict) || !Array.isArray(v.findings)
    || !v.verify || v.verify.cmd !== task.verify_cmd || !exits.includes(v.verify.exit)
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

export function registerChecker(host: TaskWorkerHost, config: CheckerConfig) {
  const runner = config.runner ?? runBinary;
  const active = new Map<string, Promise<CheckerRecord | undefined>>();
  const repositories = new Map<string, Promise<unknown>>();
  const check = async (update: WorkerTaskUpdate): Promise<CheckerRecord | undefined> => {
    if (update.status !== "implemented") return;
    const cwd = update.environment;
    if (!cwd || !update.repository || !update.projectId || !update.providerId) {
      throw new Error("Implemented worker update lacks execution context");
    }
    const task = await readWorkerTask(host, cwd, update.feature, update.task);
    const provider = (config.checkerProvider && config.checkerProvider !== update.providerId
      ? config.checkerProvider : config.providers.find(p => p !== update.providerId)) ?? config.providers[0];
    const record: CheckerRecord = { status: "error", independent: !!provider && provider !== update.providerId,
      provider: provider ?? "", fixTasks: [] };
    try {
      if (!provider || !config.providers.includes(provider)) throw new Error("Checker provider is not configured");
      const diff = await runner("git", ["diff", update.base ?? await host.baseCommit(update.repository), "--"], cwd);
      if (diff.exit !== 0) throw new Error(diff.stderr || "Cannot read checker diff");
      const exits: number[] = [];
      let executionEnvironment = cwd;
      const thread = await spawnTaskThread(host, {
        repository: cwd, projectId: update.projectId, providerId: provider,
        environment: { type: "provider", environmentProviderId: "environment-git-worktree" },
        env: { CG_TASK: task.id }, title: `Checker ${update.feature}/${task.id}`,
        origin: "plugin", originPluginId: "hyperfide-spec",
        prompt: JSON.stringify({ criteria: task.criteria, diff: diff.stdout, laneLog: await config.laneLog(update),
          verifyCmd: task.verify_cmd, instruction: "Run the verify tool yourself, then write .hyperfide/checker-verdict.json containing {verdict: pass|findings, findings: [{file,line,severity,claim}], verify: {cmd,exit}}." }),
        tools: { verify: async () => {
          const result = await runner("bash", ["-lc", task.verify_cmd], executionEnvironment);
          exits.push(result.exit);
          return result;
        } },
      });
      executionEnvironment = thread.environment;
      await new Promise<void>((resolve, reject) => {
        const unsubscribe = host.onStopped(thread.id, async () => {
          try { unsubscribe(); resolve(); } catch (error) { reject(error); }
        });
      });
      const verdict = parseVerdict(JSON.parse(await host.readFile(thread.environment, ".hyperfide/checker-verdict.json")), task, exits);
      record.verdict = verdict;
      const ids = new Set(featureFromKvx(update.feature, await host.readFile(cwd, `spec/${update.feature}/spec.kvx`)).tasks.map(t => t.id));
      for (const finding of verdict.findings) {
        let next = 1;
        while (ids.has(`${task.wave}.${next}`)) next++;
        const id = `${task.wave}.${next}`;
        const result = await runner(config.binary ?? "hyperfide", ["spec", "add", id,
          "--title", `Checker ${finding.severity}: ${finding.claim}`, "--wave", String(task.wave),
          "--requires", task.id, "--touches", finding.file, "--verify", task.verify_cmd,
          "--do", `${finding.file}:${finding.line} [${finding.severity}] ${finding.claim}`,
          "--reqs", task.reqs.join(",")], cwd);
        if (result.exit !== 0) throw new Error(result.stderr || "Cannot append checker fix task");
        ids.add(id); record.fixTasks.push(id);
      }
      record.status = verdict.verdict;
    } catch (error) { record.error = String(error); }
    await config.recordChecker(task.id, record);
    return record;
  };
  const handle = (update: WorkerTaskUpdate) => {
    const cwd = update.environment ?? update.repository ?? "";
    // Coalesce repeated lifecycle notifications while a checker is running.
    const key = `${cwd}:${update.feature}/${update.task}`;
    if (!active.has(key)) {
      // Serialize each repository so concurrent verdicts cannot allocate the same fix id.
      const previous = repositories.get(cwd) ?? Promise.resolve();
      const pending = previous.catch(() => {}).then(() => check(update)).finally(() => {
        active.delete(key);
        if (repositories.get(cwd) === pending) repositories.delete(cwd);
      });
      repositories.set(cwd, pending);
      active.set(key, pending);
    }
    return active.get(key)!;
  };
  const publish = host.publish.bind(host);
  host.publish = async update => {
    await publish(update);
    await handle(update);
  };
  return handle;
}

// ---- Wave closure and publication (task 4.4)
// The host supplies repository authority, authenticated operators and storage.
export interface ClosurePluginHost extends PublicationHost {
  operator(): Promise<Operator>;
  rpc: {
    register(name: string, handler: (input: any) => Promise<unknown>): void;
  };
}
export function registerWaveClosure(host: ClosurePluginHost) {
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

export { registerLaneReceipts } from "./projection-lane-receipts";

export * from "./qualification";
import { registerQualification, type QualificationHost } from "./qualification";
export function qualificationPlugin(host: ClosurePluginHost): ReturnType<typeof registerQualification> | undefined;
export function qualificationPlugin(host: QualificationHost & TaskWorkerHost, config?: CheckerConfig): ReturnType<typeof registerQualification> | undefined;
export function qualificationPlugin(host: ClosurePluginHost | (QualificationHost & TaskWorkerHost), config?: CheckerConfig) {
  const lanes = "realtime" in host ? registerQualification(host) : undefined;
  if ("authority" in host) registerWaveClosure(host);
  if (config && "spawn" in host) registerChecker(host, config);
  return lanes;
}
export default qualificationPlugin;
