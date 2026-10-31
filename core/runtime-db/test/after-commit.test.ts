import { afterEach, describe, expect, it } from "vitest";
import { afterCommit, claimInstallTurnNumber } from "../src/index.js";
import { createMigratedConnection } from "../src/testing.js";

const connections: Awaited<ReturnType<typeof createMigratedConnection>>[] = [];
afterEach(async () => {
  for (const db of connections.splice(0)) await db.close();
});

describe("committed turn numbers", () => {
  it("discards rolled-back savepoints and keeps committed callbacks in order", async () => {
    const db = await createMigratedConnection();
    connections.push(db);
    const numbers: number[] = [];
    await db.transaction(async (tx) => {
      afterCommit(tx, async () =>
        numbers.push(await claimInstallTurnNumber(db, 1)),
      );
      await expect(
        (async () =>
          tx.transaction((nested) => {
            afterCommit(nested, () => numbers.push(999));
            throw new Error("rollback");
          }))(),
      ).rejects.toThrow("rollback");
      await tx.transaction((nested) => {
        afterCommit(nested, async () =>
          numbers.push(await claimInstallTurnNumber(db, 2)),
        );
      });
      expect(numbers).toEqual([]);
    });
    expect(numbers).toEqual([1, 2]);
  });
});
