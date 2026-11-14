// Structural transport boundary keeps daemon execution independent of plugin loading.
type FleetJobState = "queued" | "running" | "completed" | "failed" | "unknown" | "reconciling";
interface FleetJob {
  id: string;
  threadId: string;
  payload: string;
  attempt: number;
  /** The authority may return an unresolved observation while reconciling a lost effect. */
  state?: FleetJobState;
  reconciliation?: string;
}
interface FleetTransport {
  enroll(token: string): Promise<{ hostId: string; session: string }>;
  poll(hostId: string, session: string): Promise<FleetJob[]>;
  complete(hostId: string, session: string, jobId: string, attempt: number, success: boolean): Promise<void | { state?: FleetJobState; reconciliation?: string }>;
}

/** One worker per sandbox. The runner receives the assigned thread and an abort signal. */
export class FleetWorker {
  private identity?: { hostId: string; session: string };
  private active = new Map<string, AbortController>();
  private pending = new Set<Promise<void>>();
  private outcomes = new Map<string, { success: boolean; state: "ready" | "reconciling" }>();
  constructor(private readonly transport: FleetTransport,
    private readonly run: (job: FleetJob, signal: AbortSignal) => Promise<void>) {}
  async enroll(token: string) { const identity = await this.transport.enroll(token); this.identity = identity; return identity.hostId; }
  async tick() {
    if (!this.identity) throw new Error("Host is not enrolled");
    const { hostId, session } = this.identity;
    const jobs = await this.transport.poll(hostId, session);
    const assigned = new Set(jobs.map(j => `${j.id}:${j.attempt}`));
    const reconciliation = new Set(
      jobs
        .filter(job => job.state === "unknown" || job.state === "reconciling")
        .map(job => `${job.id}:${job.attempt}`),
    );
    for (const [key, controller] of this.active) {
      if (!assigned.has(key) || reconciliation.has(key)) {
        controller.abort();
        this.active.delete(key);
      }
    }
    for (const key of this.outcomes.keys()) {
      if (reconciliation.has(key)) {
        this.outcomes.get(key)!.state = "reconciling";
      } else if (!assigned.has(key) && this.outcomes.get(key)?.state !== "reconciling") {
        this.outcomes.delete(key);
      }
    }
    for (const job of jobs) {
      const key = `${job.id}:${job.attempt}`;
      if (job.state === "unknown" || job.state === "reconciling") continue;
      if (job.state && job.state !== "queued" && job.state !== "running") continue;
      if (this.active.has(key)) continue;
      const controller = new AbortController();
      this.active.set(key, controller);
      const pending = this.execute(job, controller).finally(() => {
        if (this.active.get(key) === controller) this.active.delete(key);
        this.pending.delete(pending);
      });
      this.pending.add(pending);
    }
  }
  private async execute(job: FleetJob, controller: AbortController) {
    const key = `${job.id}:${job.attempt}`;
    const prior = this.outcomes.get(key);
    let success = prior?.success ?? true;
    if (!prior) {
      try { await this.run(job, controller.signal); } catch { success = false; }
    }
    if (controller.signal.aborted || !this.identity) return;
    this.outcomes.set(key, { success, state: "ready" });
    try {
      const acknowledgement = await this.transport.complete(this.identity.hostId, this.identity.session, job.id, job.attempt, success);
      if (acknowledgement && typeof acknowledgement === "object" &&
          (acknowledgement.state === "unknown" || acknowledgement.state === "reconciling")) {
        this.outcomes.get(key)!.state = "reconciling";
      } else {
        this.outcomes.delete(key);
      }
    } catch { /* Retry the acknowledgement on the next poll without rerunning the thread. */ }
  }
  stop() { for (const controller of this.active.values()) controller.abort(); this.active.clear(); }
  async drain() { await Promise.all(this.pending); }
  async serve(signal: AbortSignal, intervalMs = 5_000) {
    try {
      while (!signal.aborted) {
        await this.tick();
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, intervalMs);
          signal.addEventListener("abort", done, { once: true });
          if (signal.aborted) done();
        });
      }
    } finally { this.stop(); }
  }
}

export function createFleetHttpTransport(serverUrl: string, request: typeof fetch = fetch): FleetTransport {
  async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await request(new URL(`/api/v1/fleet/${path}`, serverUrl), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Fleet request failed: ${response.status}`);
    return await response.json() as T;
  }
  return {
    enroll: token => post("enroll", { token }),
    poll: (hostId, session) => post("poll", { hostId, session }),
    complete: async (hostId, session, jobId, attempt, success) => post("complete", { hostId, session, jobId, attempt, success }),
  };
}
