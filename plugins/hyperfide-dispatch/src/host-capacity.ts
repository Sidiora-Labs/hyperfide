interface Host { id: string; online: boolean; capacity: number }
interface Job { state: string; hostId: string | null; previousHosts: readonly string[] }
/** Fill the least utilized host first; retries must use another machine. */
export function scheduleHost(hosts: readonly Host[], job: Job, jobs: readonly Job[]): string | null {
  const candidates = hosts.map(host => ({ host, used: jobs.filter(j => j.state === "running" && j.hostId === host.id).length }))
    .filter(({ host, used }) => host.online && used < host.capacity && !job.previousHosts.includes(host.id))
    .sort((a, b) => a.used / a.host.capacity - b.used / b.host.capacity || a.host.id.localeCompare(b.host.id));
  return candidates[0]?.host.id ?? null;
}
