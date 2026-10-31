// These checks exercise native SQLite metadata, locks, triggers or query plans.
import { isPostgresTest } from "@hyperfide/db/testing";
import { describe, expect, it } from "vitest";
import {
  createProject,
  createThread,
  listStoredEventRows,
  noopNotifier,
  upsertHost,
} from "@hyperfide/db";
import { createMigratedConnection } from "@hyperfide/db/testing";
import { parseStoredEvent } from "../../src/services/threads/thread-data.js";

async function setup() {
  const db = await createMigratedConnection();
  const host = await upsertHost(db, noopNotifier, {
    name: "test-host",
  });
  const { project } = await createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  const thread = await createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  return { db, thread };
}

describe("thread data stored event parsing", () => {
  it.skipIf(isPostgresTest)(
    "rejects malformed stored scope kinds",
    async () => {
      const { db, thread } = await setup();

      try {
        db.$client.pragma("ignore_check_constraints = ON");
        await db.$client
          .prepare(
            `INSERT INTO events (
            id,
            thread_id,
            scope_kind,
            turn_id,
            sequence,
            type,
            data,
            created_at
          )
          VALUES (
            'evt_malformed_scope_kind',
            ?,
            'bogus',
            'turn-1',
            1,
            'system/error',
            '{"message":"boom"}',
            1
          )`,
          )
          .run(thread.id);
        db.$client.pragma("ignore_check_constraints = OFF");

        const [row] = await listStoredEventRows(db, { threadId: thread.id });
        if (!row) {
          throw new Error("Expected stored event row");
        }

        expect(() => parseStoredEvent(row)).toThrow(/invalid scope_kind/);
      } finally {
        db.$client.pragma("ignore_check_constraints = OFF");
        await db.close();
      }
    },
  );
});
