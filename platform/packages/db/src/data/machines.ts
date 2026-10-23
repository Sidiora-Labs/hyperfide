import { and, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { DbConnection, DbTransaction } from "../connection.js";
import { environments, hosts, threads } from "../schema.js";

type Connection = DbConnection | DbTransaction;

const liveThreadCondition = or(
  and(isNull(threads.archivedAt), isNull(threads.deletedAt)),
  eq(threads.status, "stopping"),
  eq(threads.status, "active"),
);

export async function listProviderMachines(db: Connection, providerId: string) {
  return await db
    .select()
    .from(hosts)
    .where(
      and(
        eq(hosts.machineProviderId, providerId),
        isNull(hosts.destroyedAt),
        ne(hosts.phase, "destroyed"),
      ),
    )
    .all();
}

export async function machineHasLiveThreads(
  db: Connection,
  hostId: string,
): Promise<boolean> {
  return (
    (await db
      .select({ id: threads.id })
      .from(threads)
      .innerJoin(environments, eq(threads.environmentId, environments.id))
      .where(and(eq(environments.hostId, hostId), liveThreadCondition))
      .limit(1)
      .get()) !== undefined
  );
}

async function machineHasThreadLaunchWhere(
  db: Connection,
  hostId: string,
  threadCondition: SQL | undefined,
): Promise<boolean> {
  return (
    (await db
      .select({ id: threads.id })
      .from(hosts)
      .innerJoin(threads, eq(hosts.launchKey, threads.id))
      .where(
        and(eq(hosts.id, hostId), isNull(hosts.destroyedAt), threadCondition),
      )
      .limit(1)
      .get()) !== undefined
  );
}

export async function machineHasLiveThreadLaunch(
  db: Connection,
  hostId: string,
): Promise<boolean> {
  return await machineHasThreadLaunchWhere(db, hostId, liveThreadCondition);
}

export async function machineHasPendingThreads(
  db: Connection,
  hostId: string,
): Promise<boolean> {
  const intent = sql`case json_extract(${threads.startupContext}, '$.kind')
    when 'pending' then json_extract(${threads.startupContext}, '$.environmentIntent')
    when 'provisioning' then json_extract(${threads.startupContext}, '$.request.environmentIntent')
  end`;
  return (
    (await db
      .select({ id: threads.id })
      .from(threads)
      .leftJoin(
        environments,
        or(
          and(
            eq(environments.ownerThreadId, threads.id),
            eq(threads.status, "starting"),
          ),
          and(
            sql`json_extract(${intent}, '$.type') = 'reuse'`,
            eq(
              environments.id,
              sql`json_extract(${intent}, '$.environmentId')`,
            ),
          ),
        ),
      )
      .where(
        and(
          inArray(threads.status, ["pending", "starting"]),
          isNull(threads.archivedAt),
          isNull(threads.deletedAt),
          or(
            and(
              eq(environments.hostId, hostId),
              inArray(environments.status, [
                "creating",
                "provisioning",
                "ready",
              ]),
              isNull(environments.teardownStatus),
            ),
            sql`json_extract(${intent}, '$.type') = 'provider'
          and json_extract(${intent}, '$.machine.type') = 'existing'
          and json_extract(${intent}, '$.machine.hostId') = ${hostId}`,
          ),
        ),
      )
      .limit(1)
      .get()) !== undefined
  );
}

export async function machineHasProvisioningEnvironment(
  db: Connection,
  hostId: string,
): Promise<boolean> {
  return (
    (await db
      .select({ id: environments.id })
      .from(environments)
      .where(
        and(
          eq(environments.hostId, hostId),
          inArray(environments.status, ["creating", "provisioning"]),
        ),
      )
      .limit(1)
      .get()) !== undefined
  );
}

export async function machineHasStartingThreadLaunch(
  db: Connection,
  hostId: string,
): Promise<boolean> {
  return await machineHasThreadLaunchWhere(
    db,
    hostId,
    and(
      eq(threads.status, "starting"),
      isNull(threads.archivedAt),
      isNull(threads.deletedAt),
    ),
  );
}
