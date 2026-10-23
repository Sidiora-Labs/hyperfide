import type { HumanJob } from "../hyperfide-spec/closure-projection";
import type { closureView } from "../hyperfide-spec/wave-detail";

export interface WaveClient {
  read(): Promise<ReturnType<typeof closureView>>;
  mark(job: HumanJob): Promise<ReturnType<typeof closureView>>;
}
// Framework-independent view for the spec task detail; marks are authenticated server-side.
export async function waveClosureView(client: WaveClient) {
  const wave = await client.read();
  return {
    title: `${wave.feature}: wave ${wave.wave}`,
    ready: wave.ready,
    blockers: wave.blockers,
    tasks: wave.tasks,
    humanTasks: wave.humans.map((task) => ({
      ...task,
      operatorMark: task.mark,
      needsOperatorMark: !task.mark,
      mark: () => client.mark(task.id),
    })),
  };
}

export async function mountWaveClosure(
  element: HTMLElement,
  client: WaveClient,
): Promise<void> {
  const view = await waveClosureView(client);
  const doc = element.ownerDocument;
  const section = doc.createElement("section");
  const title = doc.createElement("h2");
  title.textContent = view.title;
  const status = doc.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = view.ready ? "Ready to publish" : "Closure blocked";
  section.append(title, status);
  const blockers = doc.createElement("ul");
  for (const blocker of view.blockers) {
    const row = doc.createElement("li");
    row.textContent = blocker;
    blockers.append(row);
  }
  section.append(blockers);
  for (const task of view.tasks) {
    const row = doc.createElement("p");
    row.textContent = `${task.id}: ${task.title} - ${task.status}; checker ${task.checker.verdict}; lanes ${task.lanes.map((lane) => lane.status).join(", ")}`;
    section.append(row);
  }
  for (const task of view.humanTasks) {
    const row = doc.createElement("p");
    row.textContent = `${task.title} (human): ${task.operatorMark ? `marked by ${task.operatorMark.operator}` : "operator mark required"} `;
    if (task.needsOperatorMark) {
      const button = doc.createElement("button");
      button.type = "button";
      button.textContent = "Mark complete";
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await task.mark();
          await mountWaveClosure(element, client);
        } catch (error) {
          status.textContent =
            error instanceof Error ? error.message : "Operator mark failed";
          button.disabled = false;
        }
      });
      row.append(button);
    }
    section.append(row);
  }
  element.replaceChildren(section);
}

import type { Lane, LaneEvent, LogEntry } from './lanes';
export interface LaneStreamClient {
  subscribe(channel: string, callback: (event: LaneEvent) => void): () => void;
  log(id: string, after: number): Promise<LogEntry[]>;
}
export async function streamLane(client: LaneStreamClient, id: string, onLog: (entry: LogEntry) => void, onState: (lane: Lane) => void) {
  const pending = new Map<number, LogEntry>();
  let sequence = 0;
  const accept = (entries: LogEntry[]) => {
    for (const entry of entries) if (entry.sequence > sequence) pending.set(entry.sequence, entry);
    while (pending.has(sequence + 1)) { const entry = pending.get(++sequence)!; pending.delete(sequence); onLog(entry); }
  };
  const off = client.subscribe('hyperfide-qualify:lane', event => { if (event.lane.id === id) { onState(event.lane); if (event.log) accept([event.log]); } });
  try { accept(await client.log(id, sequence)); } catch (error) { off(); throw error; }
  return off;
}
export async function mountLane(element: HTMLElement, client: LaneStreamClient, id: string) {
  const status = element.ownerDocument.createElement('p');
  status.setAttribute('role', 'status');
  const log = element.ownerDocument.createElement('pre');
  element.replaceChildren(status, log);
  return streamLane(client, id, entry => { log.append(entry.text); }, lane => { status.textContent = `${lane.task}: ${lane.state}`; });
}
