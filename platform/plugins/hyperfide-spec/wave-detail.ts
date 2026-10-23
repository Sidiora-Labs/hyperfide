import {
  humanJobs,
  makeHumanTasks,
  requireOperator,
  type HumanJob,
  type Operator,
  type WaveAuthority,
  type WaveSnapshot,
} from "./wave-authority";

export function closureView(wave: WaveSnapshot, publicationAsk?: string) {
  const blockers: string[] = [];
  if (!wave.tasks.length) blockers.push("Wave has no tasks");
  for (const task of wave.tasks) {
    if (task.status !== "done") blockers.push(`${task.id}: task is not done`);
    if (task.checker.verdict !== "pass" || task.checker.commit !== task.commit)
      blockers.push(`${task.id}: checker must pass at task commit`);
    if (
      !task.lanes.length ||
      task.lanes.some(
        (lane) =>
          lane.status !== "passed" ||
          lane.commit !== task.commit ||
          lane.closureCheck !== "pass",
      )
    )
      blockers.push(
        `${task.id}: lanes and closure checks must be green at task commit`,
      );
  }
  for (const job of humanJobs) {
    const tasks = wave.humans.filter(
      (task) => task.id === job && task.kind === "human",
    );
    if (
      tasks.length !== 1 ||
      !tasks[0].mark?.operator.trim() ||
      !tasks[0].mark.at
    )
      blockers.push(`${job}: operator mark required`);
  }
  if (
    wave.asks.some(
      (ask) => ask.status !== "answered" && ask.id !== publicationAsk,
    )
  )
    blockers.push("Open Asks remain");
  const humans = makeHumanTasks().map(
    (required) =>
      wave.humans.find((task) => task.id === required.id) ?? required,
  );
  return { ...wave, humans, ready: blockers.length === 0, blockers };
}

export function waveSummary(wave: WaveSnapshot): string {
  return [
    `${wave.feature} - wave ${wave.wave}`,
    "",
    ...wave.tasks.map(
      (task) => `- ${task.id}: ${task.title} [spec:${wave.feature}/${task.id}]`,
    ),
    "",
    "Checker and lanes passed. Human tasks marked by operators.",
    ...wave.humans.map(
      (task) => `- ${task.title}: ${task.mark?.operator ?? "pending"}`,
    ),
  ].join("\n");
}

export function waveDetail(authority: WaveAuthority) {
  return {
    read: async (feature: string, wave: number) =>
      closureView(await authority.read(feature, wave)),
    mark: async (
      feature: string,
      wave: number,
      job: HumanJob,
      operator: Operator,
    ) => {
      requireOperator(operator);
      if (!humanJobs.includes(job)) throw new Error("Unknown human task");
      await authority.mark(feature, wave, job, operator);
      return closureView(await authority.read(feature, wave));
    },
  };
}
