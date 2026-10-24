// These checks exercise native SQLite metadata, locks, triggers or query plans.
import { isPostgresTest } from "../src/testing.js";
import { createMigratedConnection } from "../src/testing.js";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { getHost } from "../src/data/hosts.js";
import { getThread } from "../src/data/threads.js";
import { getProject } from "../src/data/projects.js";
import { getEnvironment } from "../src/data/environments.js";
import { describe, expect, it, vi } from "vitest";
import { hosts } from "../src/schema.js";

describe("connection prepared queries", () => {
  it
    .skipIf(isPostgresTest)
    .each([getHost, getThread, getProject, getEnvironment])(
    "does not rebuild SQL for warm %s lookups",
    async (lookup) => {
      const db = await createMigratedConnection();
      const compile = vi.spyOn(SQLiteSyncDialect.prototype, "sqlToQuery");
      try {
        expect(await lookup(db, "missing-first")).toBeNull();
        expect(compile).toHaveBeenCalledOnce();
        compile.mockClear();
        for (let i = 0; i < 10; i++) {
          expect(await lookup(db, `missing-${i}`)).toBeNull();
        }
        expect(compile).not.toHaveBeenCalled();
      } finally {
        compile.mockRestore();
        await db.close();
      }
    },
  );

  it("reuses compiled lookups across transactions while seeing writes and rollbacks", async () => {
    const db = await createMigratedConnection();
    const other = await createMigratedConnection();
    try {
      await db
        .insert(hosts)
        .values({
          id: "host",
          name: "original",
          type: "persistent",
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      expect((await getHost(db, "host"))?.name).toBe("original");
      expect(await getHost(other, "host")).toBeNull();
      const compile = vi.spyOn(SQLiteSyncDialect.prototype, "sqlToQuery");
      try {
        for (let i = 0; i < 3; i++) {
          await expect(
            (async () =>
              db.transaction(async (tx) => {
                await db.$client
                  .prepare("UPDATE hosts SET name = ? WHERE id = ?")
                  .run(`changed-${i}`, "host");
                expect((await getHost(tx, "host"))?.name).toBe(`changed-${i}`);
                throw new Error("rollback");
              }))(),
          ).rejects.toThrow("rollback");
          expect((await getHost(db, "host"))?.name).toBe("original");
        }
        expect(compile).not.toHaveBeenCalled();
      } finally {
        compile.mockRestore();
      }
    } finally {
      await other.close();
      await db.close();
    }
  });
});
