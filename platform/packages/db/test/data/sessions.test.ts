// These checks exercise native SQLite metadata, locks, triggers or query plans.
import { isPostgresTest } from "../../src/testing.js";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { noopNotifier } from "../../src/notifier.js";
import {
  closeSession,
  getLatestSessionForHost,
  getSessionById,
  heartbeatSession,
  listLatestClosedSessionsForHosts,
  openSession,
} from "../../src/data/sessions.js";
import { getHost, upsertHost } from "../../src/data/hosts.js";
import { hostDaemonSessions } from "../../src/schema.js";
import { createMigratedConnection } from "../../src/testing.js";

async function setup() {
  const db = await createMigratedConnection();
  const host = await upsertHost(db, noopNotifier, {
    name: "test-host",
  });
  return { db, host };
}

describe("sessions", () => {
  it("marks the host as seen on open, heartbeat, and close", async () => {
    const { db, host } = await setup();
    expect((await getHost(db, host.id))?.lastSeenAt).toBeNull();

    const session = await openSession(db, {
      hostId: host.id,
      instanceId: "inst-1",
      hostName: "test-host",
      dataDir: "/tmp/test-host-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });
    const seenAtOpen = (await getHost(db, host.id))?.lastSeenAt ?? null;
    expect(seenAtOpen).not.toBeNull();

    await heartbeatSession(db, session.id, Date.now() + 30_000);
    const seenAtHeartbeat = (await getHost(db, host.id))?.lastSeenAt ?? null;
    expect(seenAtHeartbeat).not.toBeNull();
    expect(seenAtHeartbeat!).toBeGreaterThanOrEqual(seenAtOpen!);

    await closeSession(db, noopNotifier, session.id, "test");
    const seenAtClose = (await getHost(db, host.id))?.lastSeenAt ?? null;
    expect(seenAtClose).not.toBeNull();
    expect(seenAtClose!).toBeGreaterThanOrEqual(seenAtHeartbeat!);
  });

  it.skipIf(isPostgresTest)(
    "rolls back the lease renewal if updating host liveness fails",
    async () => {
      const { db, host } = await setup();
      const session = await openSession(db, {
        hostId: host.id,
        instanceId: "inst-1",
        hostName: "test-host",
        dataDir: "/tmp/test-host-data",
        protocolVersion: 1,
        heartbeatIntervalMs: 5_000,
        leaseTimeoutMs: 30_000,
      });
      db.$client
        .exec(`CREATE TRIGGER reject_host_liveness BEFORE UPDATE ON hosts
      BEGIN SELECT RAISE(ABORT, 'host update failed'); END`);
      await expect(
        (async () =>
          await heartbeatSession(
            db,
            session.id,
            session.leaseExpiresAt + 10_000,
          ))(),
      ).rejects.toThrow("host update failed");
      expect(await getSessionById(db, { sessionId: session.id })).toEqual(
        session,
      );
      await db.close();
    },
  );

  it("closes a session", async () => {
    const { db, host } = await setup();

    const session = await openSession(db, {
      hostId: host.id,
      instanceId: "inst-1",
      hostName: "test-host",
      dataDir: "/tmp/test-host-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });

    const closed = await closeSession(
      db,
      noopNotifier,
      session.id,
      "user-requested",
    );
    expect(closed?.status).toBe("closed");
    expect(closed?.closeReason).toBe("user-requested");
    expect(closed?.closedAt).toBeTypeOf("number");

    expect((await getSessionById(db, { sessionId: session.id }))?.status).toBe(
      "closed",
    );
  });

  it("closes old session when opening new one for same host", async () => {
    const { db, host } = await setup();

    const session1 = await openSession(db, {
      hostId: host.id,
      instanceId: "inst-1",
      hostName: "test-host",
      dataDir: "/tmp/test-host-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });

    const session2 = await openSession(db, {
      hostId: host.id,
      instanceId: "inst-2",
      hostName: "test-host",
      dataDir: "/tmp/test-host-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });

    expect(session2.id).not.toBe(session1.id);

    expect((await getLatestSessionForHost(db, { hostId: host.id }))?.id).toBe(
      session2.id,
    );

    const old = await db
      .select()
      .from(hostDaemonSessions)
      .where(eq(hostDaemonSessions.id, session1.id))
      .get();
    expect(old?.status).toBe("closed");
    expect(old?.closeReason).toBe("replaced");
  });

  it("lists the most recently closed session for each requested host", async () => {
    const { db, host } = await setup();
    const otherHost = await upsertHost(db, noopNotifier, {
      name: "test-host-2",
    });
    const openTestSession = async (hostId: string, instanceId: string) =>
      await openSession(db, {
        hostId,
        instanceId,
        hostName: "test-host",
        dataDir: "/tmp/test-host-data",
        protocolVersion: 1,
        heartbeatIntervalMs: 10_000,
        leaseTimeoutMs: 30_000,
      });

    const earlierClosed = await openTestSession(host.id, "inst-1");
    await closeSession(db, noopNotifier, earlierClosed.id, "daemon-disconnect");
    const laterClosed = await openTestSession(host.id, "inst-2");
    await closeSession(db, noopNotifier, laterClosed.id, "daemon-disconnect");
    await openTestSession(host.id, "inst-3");
    const otherClosed = await openTestSession(otherHost.id, "inst-4");
    await closeSession(db, noopNotifier, otherClosed.id, "expired");

    for (const sessionUpdate of [
      { sessionId: earlierClosed.id, closedAt: 20, updatedAt: 50 },
      { sessionId: laterClosed.id, closedAt: 30, updatedAt: 30 },
      { sessionId: otherClosed.id, closedAt: 40, updatedAt: 40 },
    ]) {
      await db
        .update(hostDaemonSessions)
        .set({
          closedAt: sessionUpdate.closedAt,
          updatedAt: sessionUpdate.updatedAt,
        })
        .where(eq(hostDaemonSessions.id, sessionUpdate.sessionId))
        .run();
    }

    const sessions = await listLatestClosedSessionsForHosts(db, {
      hostIds: [host.id, host.id, otherHost.id, "host-missing"],
    });

    expect(sessions.map((session) => session.id).sort()).toEqual(
      [laterClosed.id, otherClosed.id].sort(),
    );
  });

  it("prefers an active replacement session when latest timestamps tie", async () => {
    const { db, host } = await setup();
    const closedSession = await openSession(db, {
      hostId: host.id,
      instanceId: "inst-1",
      hostName: "test-host",
      dataDir: "/tmp/test-host-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });
    const activeSession = await openSession(db, {
      hostId: host.id,
      instanceId: "inst-2",
      hostName: "test-host",
      dataDir: "/tmp/test-host-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });

    await db
      .update(hostDaemonSessions)
      .set({
        id: "hses_z_closed",
        createdAt: 100,
        updatedAt: 100,
      })
      .where(eq(hostDaemonSessions.id, closedSession.id))
      .run();
    await db
      .update(hostDaemonSessions)
      .set({
        id: "hses_a_active",
        createdAt: 100,
        updatedAt: 100,
      })
      .where(eq(hostDaemonSessions.id, activeSession.id))
      .run();

    expect((await getLatestSessionForHost(db, { hostId: host.id }))?.id).toBe(
      "hses_a_active",
    );
  });

  it("does not overwrite an already closed session", async () => {
    const { db, host } = await setup();
    const session = await openSession(db, {
      hostId: host.id,
      instanceId: "inst-1",
      hostName: "test-host",
      dataDir: "/tmp/test-host-data",
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
    });

    await closeSession(db, noopNotifier, session.id, "replaced");
    const closedAgain = await closeSession(
      db,
      noopNotifier,
      session.id,
      "daemon-disconnect",
    );

    expect(closedAgain?.closeReason).toBe("replaced");
  });
});
