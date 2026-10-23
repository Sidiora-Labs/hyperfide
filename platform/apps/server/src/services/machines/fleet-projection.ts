import { createHash, randomBytes } from "node:crypto";
import type { FleetAuthority, FleetJob, FleetScheduler, FleetState, FleetTransport } from "@hyperfide/plugin-sdk/machine-provider";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export class FleetError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 409, message: string) { super(message); }
}
/** Projection boundary for tasks 6.2/5.4: authority storage and scheduling are injected. */
export class FleetService implements FleetTransport {
  constructor(private readonly authority: FleetAuthority, private readonly schedule: FleetScheduler,
    private readonly authorize: (operator: string) => Promise<string | null>,
    private readonly now = Date.now, private readonly lossMs = 30_000) {
    if (!Number.isFinite(lossMs) || lossMs <= 0) throw new Error("Invalid host loss deadline");
  }
  private expire(state: FleetState) {
    for (const host of state.hosts) {
      if (host.online && this.now() - host.lastSeen >= this.lossMs) {
        host.online = false;
        for (const job of state.jobs.filter(j => j.hostId === host.id && j.state === "running")) {
          job.previousHosts.push(host.id);
          job.hostId = null;
          job.state = job.attempt < 2 ? "queued" : "failed";
        }
      }
    }
  }
  private dispatch(state: FleetState) {
    this.expire(state);
    for (const job of state.jobs.filter(j => j.state === "queued")) {
      const id = this.schedule(state.hosts, job, state.jobs);
      if (id !== null) { job.hostId = id; job.attempt++; job.state = "running"; }
    }
  }
  async issue(operator: string, hostId: string, capacity: number, ttlMs: number) {
    const operatorId = await this.authorize(operator);
    if (!operatorId) throw new FleetError(403, "Operator is not authorized");
    if (!hostId.trim() || !Number.isSafeInteger(capacity) || capacity < 1 || !Number.isFinite(ttlMs) || ttlMs <= 0)
      throw new FleetError(400, "Invalid enrollment");
    const token = randomBytes(32).toString("base64url");
    await this.authority.transaction(state => {
      if (state.hosts.some(h => h.id === hostId)) throw new FleetError(409, "Host already enrolled");
      for (const old of state.enrollments.filter(e => e.hostId === hostId)) old.consumed = true;
      state.enrollments.push({ tokenHash: hash(token), hostId, capacity, operatorId, expiresAt: this.now() + ttlMs, consumed: false });
    });
    return { token, hostId };
  }
  async enroll(token: string) {
    return this.authority.transaction(state => {
      const enrollment = state.enrollments.find(e => e.tokenHash === hash(token));
      if (!enrollment || enrollment.consumed || enrollment.expiresAt <= this.now()) throw new FleetError(401, "Invalid enrollment token");
      const session = randomBytes(32).toString("base64url");
      enrollment.consumed = true;
      state.hosts.push({ id: enrollment.hostId, capacity: enrollment.capacity, lastSeen: this.now(), online: true, sessionHash: hash(session) });
      return { hostId: enrollment.hostId, session };
    });
  }
  private authenticate(state: FleetState, hostId: string, session: string) {
    const host = state.hosts.find(h => h.id === hostId && h.sessionHash === hash(session));
    if (!host) throw new FleetError(401, "Invalid host session");
    return host;
  }
  async poll(hostId: string, session: string) {
    return this.authority.transaction(state => {
      this.expire(state);
      const host = this.authenticate(state, hostId, session);
      host.online = true;
      host.lastSeen = this.now();
      this.dispatch(state);
      return structuredClone(state.jobs.filter(j => j.hostId === hostId && j.state === "running"));
    });
  }
  async complete(hostId: string, session: string, jobId: string, attempt: number, success: boolean) {
    await this.authority.transaction(state => {
      this.expire(state);
      this.authenticate(state, hostId, session);
      const job = state.jobs.find(j => j.id === jobId);
      if (!job || job.hostId !== hostId || job.attempt !== attempt || job.state !== "running") throw new FleetError(409, "Stale job attempt");
      job.state = success ? "completed" : "failed";
      this.dispatch(state);
    });
  }
  async enqueue(operator: string, id: string, threadId: string, payload: string) {
    if (!await this.authorize(operator)) throw new FleetError(403, "Operator is not authorized");
    if (!id.trim() || !threadId.trim()) throw new FleetError(400, "Job and thread IDs are required");
    await this.authority.transaction(state => {
      if (state.jobs.some(j => j.id === id)) throw new FleetError(409, "Duplicate job");
      const job: FleetJob = { id, threadId, payload, state: "queued", hostId: null, previousHosts: [], attempt: 0 };
      state.jobs.push(job);
      this.dispatch(state);
    });
  }
  async snapshot(operator: string) {
    if (!await this.authorize(operator)) throw new FleetError(403, "Operator is not authorized");
    return this.authority.transaction(state => {
      this.dispatch(state);
      return { hosts: state.hosts.map(({ sessionHash: _secret, ...h }) => ({ ...h, jobs: state.jobs.filter(j => j.hostId === h.id && j.state === "running").map(j => j.id) })), jobs: structuredClone(state.jobs) };
    });
  }
}

/** Single-server durable projection until the authority client supplies transactions. */
export class FileFleetAuthority implements FleetAuthority {
  private static queues = new Map<string, Promise<unknown>>();
  constructor(private readonly path: string) {}
  async transaction<T>(operation: (state: FleetState) => T): Promise<T> {
    const previous = FileFleetAuthority.queues.get(this.path) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const { readFile, writeFile, rename, mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      let state: FleetState;
      try { state = JSON.parse(await readFile(this.path, "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        state = { enrollments: [], hosts: [], jobs: [] };
      }
      const result = operation(state);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomBytes(8).toString("hex")}.tmp`;
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
      return result;
    });
    FileFleetAuthority.queues.set(this.path, pending);
    try { return await pending; }
    finally { if (FileFleetAuthority.queues.get(this.path) === pending) FileFleetAuthority.queues.delete(this.path); }
  }
}
