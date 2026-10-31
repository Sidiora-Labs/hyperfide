import { eq } from "drizzle-orm";
import { getSessionById, hostDaemonSessions } from "@hyperfide/db";
import type { DbConnection, HostDaemonSessionRow } from "@hyperfide/db";
import { ApiError } from "../errors.js";
import { getAuthenticatedDaemon } from "./auth.js";

type AuthenticatedDaemonContext = Parameters<typeof getAuthenticatedDaemon>[0];

interface RequireAuthorizedActiveSessionArgs {
  hostId: string;
  sessionId: string;
}

interface RequireAuthenticatedDaemonSessionArgs {
  context: AuthenticatedDaemonContext;
  db: DbConnection;
  sessionId: string;
}

type InactiveSessionReason = "active" | "closed" | "missing";

interface InactiveSessionLogFields {
  authenticatedHostId?: string;
  closeReason?: string | null;
  closedAt?: number | null;
  inactiveSessionReason: InactiveSessionReason;
  leaseExpiresAt?: number;
  leaseStaleByMs?: number;
  sessionHostId?: string;
  sessionId: string;
  sessionStatus?: string;
}

interface GetInactiveSessionLogFieldsArgs {
  authenticatedHostId?: string;
  now: number;
  sessionId: string;
}

export async function requireAuthorizedOpenSession(
  db: DbConnection,
  args: RequireAuthorizedActiveSessionArgs,
) {
  const session = await getSessionById(db, { sessionId: args.sessionId });
  if (!session || session.status !== "active") {
    throw new ApiError(401, "inactive_session", "Session is not active");
  }
  if (session.hostId !== args.hostId) {
    throw new ApiError(
      403,
      "invalid_request",
      "Session does not belong to the authenticated host",
    );
  }

  return session;
}

export async function requireAuthenticatedDaemonSession(
  args: RequireAuthenticatedDaemonSessionArgs,
): Promise<HostDaemonSessionRow> {
  const daemon = getAuthenticatedDaemon(args.context);
  return await requireAuthorizedOpenSession(args.db, {
    hostId: daemon.hostId,
    sessionId: args.sessionId,
  });
}

export async function getInactiveSessionLogFields(
  db: DbConnection,
  args: GetInactiveSessionLogFieldsArgs,
): Promise<InactiveSessionLogFields> {
  const session =
    (await db
      .select()
      .from(hostDaemonSessions)
      .where(eq(hostDaemonSessions.id, args.sessionId))
      .get()) ?? null;

  if (!session) {
    return {
      authenticatedHostId: args.authenticatedHostId,
      inactiveSessionReason: "missing",
      sessionId: args.sessionId,
    };
  }

  if (session.status !== "active") {
    return {
      authenticatedHostId: args.authenticatedHostId,
      closeReason: session.closeReason,
      closedAt: session.closedAt,
      inactiveSessionReason: "closed",
      leaseExpiresAt: session.leaseExpiresAt,
      sessionHostId: session.hostId,
      sessionId: args.sessionId,
      sessionStatus: session.status,
    };
  }

  return {
    authenticatedHostId: args.authenticatedHostId,
    inactiveSessionReason: "active",
    leaseExpiresAt: session.leaseExpiresAt,
    ...(session.leaseExpiresAt <= args.now
      ? { leaseStaleByMs: args.now - session.leaseExpiresAt }
      : {}),
    sessionHostId: session.hostId,
    sessionId: args.sessionId,
    sessionStatus: session.status,
  };
}
