import { createConnection, migrate, sql } from "@hyperfide/db";

export async function resetConfiguredDatabase(url: string): Promise<void> {
  const db = createConnection(url);
  try {
    if (db.dialect === "postgresql") {
      await db.run(sql`DROP SCHEMA IF EXISTS platform CASCADE`);
    } else {
      const tables = await db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      );
      db.$client.pragma("foreign_keys = OFF");
      for (const table of tables)
        await db.run(
          sql.raw(`DROP TABLE IF EXISTS "${table.name.replaceAll('"', '""')}"`),
        );
      db.$client.pragma("foreign_keys = ON");
    }
    await migrate(db);
  } finally {
    await db.close();
  }
}
