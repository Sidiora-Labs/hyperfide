import type { SpecReader } from "./src/reader";
import type { PluginStorage } from "@hyperfide/authority";
import type { LaneService } from "../hyperfide-qualify/lanes";
import type { CheckerRecord } from "../hyperfide-qualify/server";
import { receiptDetail } from "./receipt-detail";
import type { AskBridge } from "../hyperfide-asks/src/bridge";

export type Operator = { id: string; role: "operator" };
export type HumanJob =
  | "judge-output"
  | "provide-variables"
  | "final-system-test";
export const humanJobs: readonly HumanJob[] = [
  "judge-output",
  "provide-variables",
  "final-system-test",
];
export interface HumanTask {
  id: HumanJob;
  kind: "human";
  title: string;
  mark?: { operator: string; at: string };
}
export interface ClosureTask {
  id: string;
  title: string;
  status: string;
  commit: string;
  checker: { verdict: "pass" | "findings" | "pending"; commit: string };
  lanes: { status: string; commit: string; closureCheck: "pass" | "fail" }[];
}
export interface WaveSnapshot {
  feature: string;
  wave: number;
  tasks: ClosureTask[];
  humans: HumanTask[];
  asks: { id: string; status: string }[];
}
export interface PermissionAsk {
  id: string;
  kind: "permission";
  status: "open" | "answered";
  answer?: "grant" | "refuse";
  operator?: string;
  binding: string;
}
export interface PublicationAsks {
  policy(kind: "permission"): Promise<{ blocks: boolean }>;
  raise(input: {
    kind: "permission";
    question: string;
    binding: string;
    options: ["grant", "refuse"];
  }): Promise<PermissionAsk>;
  get(id: string): Promise<PermissionAsk>;
}
export interface WaveAuthority {
  read(feature: string, wave: number): Promise<WaveSnapshot>;
  mark(
    feature: string,
    wave: number,
    job: HumanJob,
    operator: Operator,
  ): Promise<void>;
}
export function requireOperator(operator: Operator): void {
  if (operator?.role !== "operator" || !operator.id?.trim())
    throw new Error("Operator identity required");
}
export function makeHumanTasks(): HumanTask[] {
  return [
    { id: "judge-output", kind: "human", title: "Judge output" },
    { id: "provide-variables", kind: "human", title: "Provide variables" },
    { id: "final-system-test", kind: "human", title: "Final system test" },
  ];
}

/** Read closure evidence from the same services used by task and lane detail. */
export function createWaveAuthority(input: {
  repository: string;
  reader: SpecReader;
  lanes: Pick<LaneService, "list">;
  asks: Pick<AskBridge, "list">;
  storage: Pick<PluginStorage, "get" | "put">;
  checker(feature: string, task: string): Promise<{ commit: string; record: CheckerRecord } | undefined>;
}): WaveAuthority {
  const key = (feature: string, wave: number) => `human-marks:${feature}/${wave}`;
  return {
    async read(feature, wave) {
      const snapshot = await input.reader.refresh();
      if (snapshot.stale) throw new Error("Stale spec cannot close a wave");
      const tasks = (await input.reader.tasks(feature)).filter(task => task.wave === wave);
      const lanes = input.lanes.list(input.repository).filter(lane => lane.feature === feature);
      const marks = await input.storage.get<HumanTask[]>(key(feature, wave));
      return {
        feature, wave, humans: marks ?? makeHumanTasks(),
        asks: (await input.asks.list(input.repository)).map(ask => ({ id: String(ask.id), status: ask.state })),
        tasks: await Promise.all(tasks.map(async task => {
          const checked = await input.checker(feature, task.id);
          const receipts = await receiptDetail(input.repository, task.id,
            `spec/${feature}/spec.kvx`, async () => {});
          const taskLanes = lanes.filter(lane => lane.task === task.id);
          const commit = taskLanes.at(-1)?.commit ?? "";
          return {
            id: task.id, title: task.title, status: task.status, commit,
            checker: { commit: checked?.commit ?? "", verdict: checked?.record.status === "pass" ? "pass" as const
              : checked?.record.status === "findings" ? "findings" as const : "pending" as const },
            lanes: taskLanes.map(lane => ({
              status: lane.state, commit: lane.commit ?? "",
              closureCheck: receipts.some(detail => detail.receipt.commit === lane.commit
                && detail.receipt.exit === 0 && detail.warnings.length === 0)
                ? "pass" as const : "fail" as const,
            })),
          };
        })),
      };
    },
    async mark(feature, wave, job, operator) {
      requireOperator(operator);
      if (!humanJobs.includes(job)) throw new Error("Unknown human task");
      const marks = await input.storage.get<HumanTask[]>(key(feature, wave)) ?? makeHumanTasks();
      marks.find(task => task.id === job)!.mark = { operator: operator.id, at: new Date().toISOString() };
      await input.storage.put(key(feature, wave), marks);
    },
  };
}
