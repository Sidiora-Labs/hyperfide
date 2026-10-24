import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAsyncPluginDatabase,
  type AsyncPluginDatabase,
} from "@hyperfide/db";
const connections: AsyncPluginDatabase[] = [];
afterEach(async () => {
  for (const db of connections.splice(0)) await db.close();
});
async function open() {
  const db = await createAsyncPluginDatabase(
    process.env.HYPERFIDE_DATABASE_URL ?? ":memory:",
    `hyperfide-test-${randomUUID()}`,
  );
  connections.push(db);
  return db;
}
const statements = [
  "CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT NOT NULL)",
];
describe("portable plugin storage", () => {
  it("keeps independent writes outside a concurrently rolled back transaction", async () => {
    const db = await open();
    await db.migrate(statements);
    let started!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = db
      .transaction(async (tx) => {
        await tx.execute(
          "INSERT INTO records VALUES ('rollback', 'temporary')",
        );
        started();
        await held;
        throw new Error("rollback");
      })
      .catch((error) => error);
    await ready;
    const independent = db.execute(
      "INSERT INTO records VALUES ('independent', 'retained')",
    );
    release();
    expect(await transaction).toMatchObject({ message: "rollback" });
    await independent;
    expect(await db.query("SELECT * FROM records")).toEqual([
      { id: "independent", value: "retained" },
    ]);
  });
  it("isolates namespaces and applies immutable migrations once", async () => {
    const first = await open();
    const second = await open();
    await first.migrate(statements);
    await second.migrate(statements);
    await first.migrate(statements);
    await expect(
      first.migrate(["CREATE TABLE changed (id TEXT)"]),
    ).rejects.toThrow("changed");
    await first.execute(
      first.dialect === "postgresql"
        ? "INSERT INTO records VALUES ($1, $2)"
        : "INSERT INTO records VALUES (?, ?)",
      ["one", "stored"],
    );
    expect(await first.query("SELECT * FROM records")).toEqual([
      { id: "one", value: "stored" },
    ]);
    expect(await second.query("SELECT * FROM records")).toEqual([]);
  });
  it("rolls back asynchronous transactions and nested savepoints", async () => {
    const db = await open();
    await db.migrate(statements);
    await expect(
      db.transaction(async (tx) => {
        await tx.execute("INSERT INTO records VALUES ('one', 'rolled back')");
        await tx.transaction(async (nested) => {
          await nested.execute("INSERT INTO records VALUES ('two', 'nested')");
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await db.query("SELECT * FROM records")).toEqual([]);
  });
});
