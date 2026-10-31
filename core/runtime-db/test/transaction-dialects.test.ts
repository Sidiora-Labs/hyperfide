import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { afterCommit } from "../src/connection.js";
import { createMigratedConnection } from "../src/testing.js";

describe("async transaction dialect contract", () => {
  it("rolls back root queries and runs callbacks after committed queries", async () => {
    const db = await createMigratedConnection();
    const callbacks: number[] = [];
    try {
      await db.run(
        sql`CREATE TABLE transaction_contract (value INTEGER NOT NULL)`,
      );
      await expect(
        db.transaction(async (tx) => {
          await db.run(sql`INSERT INTO transaction_contract VALUES (1)`);
          afterCommit(tx, () => {
            callbacks.push(1);
          });
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");
      expect(await db.all(sql`SELECT value FROM transaction_contract`)).toEqual(
        [],
      );
      expect(callbacks).toEqual([]);
      await db.transaction(async (tx) => {
        await db.run(sql`INSERT INTO transaction_contract VALUES (2)`);
        afterCommit(tx, async () => {
          const row = await db.get<{ value: number }>(
            sql`SELECT value FROM transaction_contract`,
          );
          callbacks.push(row!.value);
        });
      });
      expect(callbacks).toEqual([2]);
    } finally {
      await db.close();
    }
  });
});
