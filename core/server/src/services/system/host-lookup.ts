import type { SystemProvidersQuery } from "@hyperfide/server-contract";
import type { WorkSessionDeps } from "../../types.js";
import { requireEnvironment } from "../lib/entity-lookup.js";
import {
  assertUsableHostId,
  requireConnectedPrimaryHostId,
} from "../hosts/primary-host.js";

type SystemHostLookupQuery = Pick<
  SystemProvidersQuery,
  "environmentId" | "hostId"
>;

export async function resolveSystemLookupHostId(
  deps: WorkSessionDeps,
  query: SystemHostLookupQuery,
): Promise<string> {
  if (query.environmentId) {
    const environment = await requireEnvironment(deps.db, query.environmentId);
    await assertUsableHostId(deps, { hostId: environment.hostId });
    return environment.hostId;
  }
  if (query.hostId) {
    await assertUsableHostId(deps, { hostId: query.hostId });
    return query.hostId;
  }
  return await requireConnectedPrimaryHostId(deps);
}
