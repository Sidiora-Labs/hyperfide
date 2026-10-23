// Temporary boundary for unmerged spec, receipt, checker and Asks plugins (4.2/4.3/3.2).
// Hosts supply authoritative snapshots and authenticated operator identities.
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
export interface AsksProjection {
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
