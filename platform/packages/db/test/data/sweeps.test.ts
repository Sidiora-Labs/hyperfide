import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbConnection } from "../../src/connection.js";
import { noopNotifier } from "../../src/notifier.js";
import { pruneClosedSessions } from "../../src/data/sweeps.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { openSession } from "../../src/data/sessions.js";
import { hostDaemonSessions } from "../../src/schema.js";
import { createMigratedConnection } from "../../src/testing.js";

async function setup() {
  const db = await createMigratedConnection();
  const host = await upsertHost(db, noopNotifier, {
    name: "test-host",
  });
  const { project } = await createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  return { db, host, project };
}

describe("pruneClosedSessions", () => {
  async function openClosedSessionAt(args: {
    closedAt: number;
    db: DbConnection;
    hostId: string;
    instanceId: string;
  }): Promise<string> {
    const session = await openSession(args.db, {
      hostId: args.hostId,
      instanceId: args.instanceId,
      hostName: "test-host",
      dataDir: "/tmp/test-host-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });
    await args.db
      .update(hostDaemonSessions)
      .set({
        status: "closed",
        closedAt: args.closedAt,
        closeReason: "replaced",
        updatedAt: args.closedAt,
      })
      .where(eq(hostDaemonSessions.id, session.id))
      .run();
    return session.id;
  }

  it("deletes closed sessions older than the threshold", async () => {
    const { db, host } = await setup();
    const now = Date.now();

    const stale = await openClosedSessionAt({
      closedAt: now - 10_000,
      db,
      hostId: host.id,
      instanceId: "inst-stale",
    });
    const fresh = await openClosedSessionAt({
      closedAt: now - 1_000,
      db,
      hostId: host.id,
      instanceId: "inst-fresh",
    });
    const active = await openSession(db, {
      hostId: host.id,
      instanceId: "inst-active",
      hostName: "test-host",
      dataDir: "/tmp/test-host-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });

    expect(
      await pruneClosedSessions(db, {
        closedBefore: now - 5_000,
        limit: 100,
      }),
    ).toEqual({ deleted: 1 });

    expect(
      (
        await db
          .select({ id: hostDaemonSessions.id })
          .from(hostDaemonSessions)
          .all()
      )
        .map((row) => row.id)
        .sort(),
    ).toEqual([fresh, active.id].sort());
    expect(
      await db
        .select()
        .from(hostDaemonSessions)
        .where(eq(hostDaemonSessions.id, stale))
        .get(),
    ).toBeUndefined();
  });

  it("honors the delete batch limit", async () => {
    const { db, host } = await setup();
    const now = Date.now();
    const closedAt = now - 10_000;

    for (const instanceId of ["inst-a", "inst-b", "inst-c"]) {
      await openClosedSessionAt({ closedAt, db, hostId: host.id, instanceId });
    }

    expect(
      await pruneClosedSessions(db, {
        closedBefore: now - 5_000,
        limit: 2,
      }),
    ).toEqual({ deleted: 2 });
    expect(
      await db
        .select()
        .from(hostDaemonSessions)
        .where(eq(hostDaemonSessions.status, "closed"))
        .all(),
    ).toHaveLength(1);
  });
});
