import { inArray } from "drizzle-orm";
import {
  defaultExperiments,
  earlyAdopterExperiments,
  experimentKeys,
  experimentKeySchema,
  type ExperimentUpdates,
  type Experiments,
} from "@hyperfide/domain";
import type { DbConnection } from "../connection.js";
import { systemExperiments } from "../schema.js";
import { getEarlyAdopter } from "./app-settings.js";

export async function getExperiments(db: DbConnection): Promise<Experiments> {
  const experiments = (await getEarlyAdopter(db))
    ? { ...earlyAdopterExperiments }
    : { ...defaultExperiments };
  const rows = await db
    .select()
    .from(systemExperiments)
    .where(inArray(systemExperiments.key, [...experimentKeys]))
    .all();

  for (const row of rows) {
    const key = experimentKeySchema.safeParse(row.key);
    if (key.success) {
      experiments[key.data] = row.value;
    }
  }

  return experiments;
}

export async function setExperiments(
  db: DbConnection,
  updates: ExperimentUpdates,
): Promise<void> {
  const updatedAt = Date.now();
  await db.transaction(async (transaction) => {
    for (const key of experimentKeys) {
      const value = updates[key];
      if (value === undefined) continue;
      await transaction
        .insert(systemExperiments)
        .values({ key, value, updatedAt })
        .onConflictDoUpdate({
          target: systemExperiments.key,
          set: { value, updatedAt },
        })
        .run();
    }
  });
}
