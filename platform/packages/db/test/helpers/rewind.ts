import type { DbConnection } from "../../src/index.js";

export async function dropPluginEnabledFollowsDefaultColumn(
  db: DbConnection,
): Promise<void> {
  const columns = await db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(plugins)")
    .all();
  if (columns.some((column) => column.name === "enabled_follows_default")) {
    await db.$client.exec(
      "ALTER TABLE plugins DROP COLUMN enabled_follows_default",
    );
  }
}

export async function rewindThreadPruningWork(db: DbConnection): Promise<void> {
  await db.$client.exec(`
    DROP TABLE IF EXISTS thread_pruning_work;
    DELETE FROM __drizzle_migrations WHERE created_at >= 1791399370294;
  `);
  const columns = await db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(thread_pruning_cursors)")
    .all();
  if (columns.some((column) => column.name === "work_revision"))
    await db.$client.exec(
      "ALTER TABLE thread_pruning_cursors DROP COLUMN work_revision",
    );
}

export function dropIdleLifecycleIndexes(db: DbConnection): void {
  for (const name of [
    "hosts_pending_provider_idx",
    "threads_deleted_cleanup_idx",
  ]) {
    db.$client.exec(`DROP INDEX IF EXISTS ${name}`);
  }
}

export async function dropQueuedMessageEditHeldUntilColumn(
  db: DbConnection,
): Promise<void> {
  const columns = await db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(queued_thread_messages)")
    .all();
  if (columns.some((column) => column.name === "edit_held_until")) {
    await db.$client.exec(
      "ALTER TABLE queued_thread_messages DROP COLUMN edit_held_until",
    );
  }
}

export async function dropMarketplaceSourceGitSubdirectoryColumn(
  db: DbConnection,
): Promise<void> {
  const columns = await db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(plugin_marketplaces)")
    .all();
  if (columns.some((column) => column.name === "source_git_subdirectory")) {
    await db.$client.exec(
      "ALTER TABLE plugin_marketplaces DROP COLUMN source_git_subdirectory",
    );
  }
}

export async function dropThreadParentNotificationsColumn(
  db: DbConnection,
): Promise<void> {
  const columns = await db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(threads)")
    .all();
  if (columns.some((column) => column.name === "parent_notifications")) {
    await db.$client.exec(
      "ALTER TABLE threads DROP COLUMN parent_notifications",
    );
  }
}

export const QUEUED_MESSAGE_STATE_MIGRATION_WHEN = 1792010323040;

interface QueuedTableColumn {
  dflt_value: string | null;
  name: string;
  notnull: number;
  pk: number;
  type: string;
}

export async function rewindQueuedMessageStateMigration(
  db: DbConnection,
): Promise<void> {
  const columns = await db.$client
    .prepare<[], QueuedTableColumn>("PRAGMA table_info(queued_thread_messages)")
    .all();
  if (!columns.some((column) => column.name === "state")) return;
  const keptColumns = columns.filter((column) => column.name !== "state");
  const definitions = keptColumns
    .map((column) =>
      [
        `"${column.name}" ${column.type}`,
        column.pk ? "PRIMARY KEY" : "",
        column.notnull ? "NOT NULL" : "",
        column.dflt_value === null ? "" : `DEFAULT ${column.dflt_value}`,
        column.name === "thread_id"
          ? "REFERENCES threads(id) ON DELETE cascade"
          : "",
      ]
        .filter((part) => part !== "")
        .join(" "),
    )
    .join(",\n      ");
  const names = keptColumns.map((column) => `"${column.name}"`).join(", ");
  await db.$client.exec(`
    CREATE TABLE __rewound_queued_thread_messages (
      ${definitions}
    );
    INSERT INTO __rewound_queued_thread_messages (${names})
      SELECT ${names} FROM queued_thread_messages;
    DROP TABLE queued_thread_messages;
    ALTER TABLE __rewound_queued_thread_messages RENAME TO queued_thread_messages;
    CREATE INDEX queued_thread_messages_thread_created_idx ON queued_thread_messages (thread_id, created_at, id);
    CREATE INDEX queued_thread_messages_thread_sort_idx ON queued_thread_messages (thread_id, sort_key, id);
    CREATE INDEX queued_thread_messages_due_idx ON queued_thread_messages (send_at, id) WHERE send_at IS NOT NULL AND claimed_at IS NULL AND claim_token IS NULL;
    CREATE INDEX queued_thread_messages_wait_holder_idx ON queued_thread_messages (wait_holder, id) WHERE wait_holder IS NOT NULL;
    DELETE FROM __drizzle_migrations WHERE created_at >= ${QUEUED_MESSAGE_STATE_MIGRATION_WHEN};
  `);
}
