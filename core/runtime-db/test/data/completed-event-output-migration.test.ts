// These checks exercise native SQLite metadata, locks, triggers or query plans.
import { isPostgresTest } from "../../src/testing.js";
import { turnScope } from "@hyperfide/domain";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createConnection, type DbConnection } from "../../src/connection.js";
import { listStoredEventRows } from "../../src/data/events.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import {
  hydrateRetainedEventOutputRows,
  hydrateRetainedEventOutputRowsWithinDataByteLimit,
} from "../../src/data/retained-event-outputs.js";
import {
  migrateNextCompletedEventItemOutput,
  migrateNextLegacyImageGenerationOutput,
} from "../../src/data/sweeps.js";
import {
  COMPLETED_EVENT_OUTPUT_RETENTION_MS,
  COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS,
  RETAINED_EVENT_OUTPUT_TARGETS,
  type RetainedEventOutputTarget,
} from "../../src/retained-event-output.js";
import { createThread } from "../../src/data/threads.js";
import { noopNotifier } from "../../src/notifier.js";
import {
  events,
  maintenanceScanCursors,
  retainedEventOutputs,
  threadPruningWork,
} from "../../src/schema.js";
import { createMigratedConnection } from "../../src/testing.js";

async function setup() {
  const db = await createMigratedConnection();
  const host = await upsertHost(db, noopNotifier, {
    name: "completed-output-migration-host",
  });
  const { project } = await createProject(db, noopNotifier, {
    name: "completed-output-migration-project",
    source: {
      hostId: host.id,
      path: "/tmp/completed-output-migration",
      type: "local_path",
    },
  });
  const thread = await createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  return { db, thread };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOutput(data: string, outputPath: string): string {
  const value: unknown = JSON.parse(data);
  if (
    !isRecord(value) ||
    !isRecord(value.item) ||
    typeof value.item[outputPath] !== "string"
  ) {
    throw new Error(`Expected string output at ${outputPath}`);
  }
  return value.item[outputPath];
}

function readLegacyImageGenerationOutput(data: string): string {
  const value: unknown = JSON.parse(data);
  if (
    !isRecord(value) ||
    !isRecord(value.rawEvent) ||
    !isRecord(value.rawEvent.params) ||
    !isRecord(value.rawEvent.params.item) ||
    typeof value.rawEvent.params.item.result !== "string"
  ) {
    throw new Error("Expected legacy image generation result");
  }
  return value.rawEvent.params.item.result;
}

interface InsertLegacyOutputArgs extends RetainedEventOutputTarget {
  createdAt: number;
  data?: string;
  db: DbConnection;
  eventId: string;
  itemType?: string;
  output: string;
  sequence: number;
  threadId: string;
  truncation?: Record<string, unknown>;
}

async function insertLegacyOutput(args: InsertLegacyOutputArgs): Promise<void> {
  const itemId = `${args.eventId}-item`;
  await args.db
    .insert(events)
    .values({
      createdAt: args.createdAt,
      data:
        args.data ??
        JSON.stringify({
          item: {
            [args.outputPath]: args.output,
            id: itemId,
            truncation: args.truncation,
            type: args.itemType ?? args.itemKind,
          },
        }),
      id: args.eventId,
      itemId,
      itemKind: args.itemKind,
      parentToolCallId: null,
      providerThreadId: null,
      scopeKind: turnScope(`turn-${args.eventId}`).kind,
      sequence: args.sequence,
      threadId: args.threadId,
      turnId: `turn-${args.eventId}`,
      type: "item/completed",
    })
    .run();
}

async function migrateCommandOutput(db: DbConnection, migratedAt: number) {
  return await migrateNextCompletedEventItemOutput(db, {
    itemKind: "commandExecution",
    limit: 10,
    migratedAt,
    outputPath: "aggregatedOutput",
  });
}

async function insertLegacyImageGeneration(args: {
  createdAt: number;
  db: DbConnection;
  eventId: string;
  output: string;
  sequence: number;
  threadId: string;
}): Promise<void> {
  await args.db
    .insert(events)
    .values({
      createdAt: args.createdAt,
      data: JSON.stringify({
        providerId: "codex",
        rawEvent: {
          jsonrpc: "2.0",
          method: "item/completed",
          params: {
            item: {
              failure: null,
              id: `${args.eventId}-item`,
              result: args.output,
              revisedPrompt: "Draw a compact test image",
              savedPath: "/tmp/generated.png",
              status: "completed",
              transparentBackground: false,
              type: "imageGeneration",
            },
            threadId: "codex-thread",
            turnId: `turn-${args.eventId}`,
          },
        },
        rawType: "item/completed",
      }),
      id: args.eventId,
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      providerThreadId: "codex-thread",
      scopeKind: "turn",
      sequence: args.sequence,
      threadId: args.threadId,
      turnId: `turn-${args.eventId}`,
      type: "provider/unhandled",
    })
    .run();
}

async function migrateLegacyImageGeneration(
  db: DbConnection,
  migratedAt: number,
) {
  return await migrateNextLegacyImageGenerationOutput(db, {
    limit: 10,
    migratedAt,
  });
}

describe("completed event output migration", () => {
  it.each(["completed", "legacy-image"] as const)(
    "queues %s rewrites atomically with event migration",
    async (kind) => {
      const { db, thread } = await setup();
      const migratedAt = 1_800_000_000_000;
      try {
        const args = {
          db,
          threadId: thread.id,
          eventId: "rewrite",
          sequence: 1,
          createdAt: migratedAt - 1,
          output: "x".repeat(50_000),
        };
        if (kind === "completed")
          await insertLegacyOutput({
            ...args,
            itemKind: "commandExecution",
            outputPath: "aggregatedOutput",
          });
        else await insertLegacyImageGeneration(args);
        const migrateOutput = async () =>
          kind === "completed"
            ? await migrateCommandOutput(db, migratedAt)
            : await migrateLegacyImageGeneration(db, migratedAt);
        const before = await listStoredEventRows(db, { threadId: thread.id });
        await expect(
          (async () =>
            db.transaction(async () => {
              expect((await migrateOutput()).action).toBe("migrated");
              throw new Error("rollback rewrite");
            }))(),
        ).rejects.toThrow("rollback rewrite");
        expect(await listStoredEventRows(db, { threadId: thread.id })).toEqual(
          before,
        );
        expect(await db.select().from(threadPruningWork).all()).toEqual([]);
        expect((await migrateOutput()).action).toBe("migrated");
        expect(await db.select().from(threadPruningWork).all()).toEqual([
          { policy: "resolved-items", threadId: thread.id, revision: 1 },
        ]);
      } finally {
        await db.close();
      }
    },
  );

  it("migrates one retained legacy inline output without changing raw reads", async () => {
    const migratedAt = 1_800_000_000_000;
    const createdAt = migratedAt - 60_000;
    const output =
      "legacy-head-" +
      "x".repeat(COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS) +
      "-legacy-tail";
    const { db, thread } = await setup();
    await insertLegacyOutput({
      createdAt,
      db,
      eventId: "evt_legacy_command",
      itemKind: "commandExecution",
      output,
      outputPath: "aggregatedOutput",
      sequence: 1,
      threadId: thread.id,
    });

    expect(
      await migrateNextCompletedEventItemOutput(db, {
        itemKind: "commandExecution",
        limit: 10,
        migratedAt,
        outputPath: "aggregatedOutput",
      }),
    ).toMatchObject({
      action: "migrated",
      eventId: "evt_legacy_command",
      migratedRows: 1,
      retained: true,
      threadId: thread.id,
    });

    const [stored] = await listStoredEventRows(db, { threadId: thread.id });
    if (!stored) {
      throw new Error("Expected migrated event");
    }
    expect(readOutput(stored.data, "aggregatedOutput")).not.toBe(output);
    const [hydrated] = await hydrateRetainedEventOutputRows(
      db,
      [stored],
      migratedAt,
    );
    expect(hydrated && readOutput(hydrated.data, "aggregatedOutput")).toBe(
      output,
    );
    await db.close();
  });

  it("migrates every authoritative output path one row at a time", async () => {
    const migratedAt = 1_800_000_000_000;
    const output = "p".repeat(
      COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS + 1,
    );
    const { db, thread } = await setup();
    for (const [index, target] of RETAINED_EVENT_OUTPUT_TARGETS.entries()) {
      await insertLegacyOutput({
        ...target,
        createdAt: migratedAt - 1,
        db,
        eventId: `evt_path_${index}`,
        output: `${target.itemKind}-${output}`,
        sequence: index + 1,
        threadId: thread.id,
      });
    }

    for (const [index, target] of RETAINED_EVENT_OUTPUT_TARGETS.entries()) {
      expect(
        await migrateNextCompletedEventItemOutput(db, {
          ...target,
          limit: 10,
          migratedAt,
        }),
      ).toMatchObject({
        action: "migrated",
        eventId: `evt_path_${index}`,
        migratedRows: 1,
        retained: true,
      });
    }

    expect(await db.select().from(retainedEventOutputs).all()).toHaveLength(
      RETAINED_EVENT_OUTPUT_TARGETS.length,
    );
    const stored = await listStoredEventRows(db, { threadId: thread.id });
    const hydrated = await hydrateRetainedEventOutputRows(
      db,
      stored,
      migratedAt,
    );
    for (const [index, target] of RETAINED_EVENT_OUTPUT_TARGETS.entries()) {
      const row = hydrated.find(
        (candidate) => candidate.id === `evt_path_${index}`,
      );
      expect(row && readOutput(row.data, target.outputPath)).toBe(
        `${target.itemKind}-${output}`,
      );
    }
    await db.close();
  });

  it("uses the new-write UTF-16 threshold for astral Unicode output", async () => {
    const migratedAt = 1_800_000_000_000;
    const output = "😀".repeat(20_000);
    const { db, thread } = await setup();
    await insertLegacyOutput({
      createdAt: migratedAt - 1,
      db,
      eventId: "evt_astral_unicode",
      itemKind: "commandExecution",
      output,
      outputPath: "aggregatedOutput",
      sequence: 1,
      threadId: thread.id,
    });

    expect(output.length).toBe(40_000);
    expect(await migrateCommandOutput(db, migratedAt)).toMatchObject({
      action: "migrated",
      eventId: "evt_astral_unicode",
      migratedRows: 1,
      retained: true,
    });
    const [stored] = await listStoredEventRows(db, { threadId: thread.id });
    const [hydrated] = await hydrateRetainedEventOutputRows(
      db,
      stored ? [stored] : [],
      migratedAt,
    );
    expect(hydrated && readOutput(hydrated.data, "aggregatedOutput")).toBe(
      output,
    );
    await db.close();
  });

  it("previews an already expired output without retaining a sidecar", async () => {
    const migratedAt = 1_800_000_000_000;
    const createdAt = migratedAt - COMPLETED_EVENT_OUTPUT_RETENTION_MS;
    const output = "expired-" + "e".repeat(40_000);
    const { db, thread } = await setup();
    await insertLegacyOutput({
      createdAt,
      db,
      eventId: "evt_expired",
      itemKind: "commandExecution",
      output,
      outputPath: "aggregatedOutput",
      sequence: 1,
      threadId: thread.id,
    });

    expect(await migrateCommandOutput(db, migratedAt)).toMatchObject({
      action: "migrated",
      migratedRows: 1,
      retained: false,
    });
    expect(await db.select().from(retainedEventOutputs).all()).toEqual([]);
    const [stored] = await listStoredEventRows(db, { threadId: thread.id });
    if (!stored) {
      throw new Error("Expected expired migrated event");
    }
    expect(readOutput(stored.data, "aggregatedOutput")).not.toBe(output);
    expect(
      (await hydrateRetainedEventOutputRows(db, [stored], migratedAt))[0]?.data,
    ).toBe(stored.data);
    expect(
      JSON.parse(stored.data).item.truncation.aggregatedOutput.truncatedAt,
    ).toBe(createdAt + COMPLETED_EVENT_OUTPUT_RETENTION_MS);
    await db.close();
  });

  it("skips malformed, extension, small, and already previewed rows", async () => {
    const migratedAt = 1_800_000_000_000;
    const output = "s".repeat(40_000);
    const { db, thread } = await setup();
    await insertLegacyOutput({
      createdAt: migratedAt - 4,
      data: "{malformed",
      db,
      eventId: "evt_skip_1_malformed",
      itemKind: "commandExecution",
      output,
      outputPath: "aggregatedOutput",
      sequence: 1,
      threadId: thread.id,
    });
    await insertLegacyOutput({
      createdAt: migratedAt - 3,
      db,
      eventId: "evt_skip_2_extension",
      itemKind: "commandExecution",
      itemType: "extensionItem",
      output,
      outputPath: "aggregatedOutput",
      sequence: 2,
      threadId: thread.id,
    });
    await insertLegacyOutput({
      createdAt: migratedAt - 2,
      db,
      eventId: "evt_skip_3_small",
      itemKind: "commandExecution",
      output: "small",
      outputPath: "aggregatedOutput",
      sequence: 3,
      threadId: thread.id,
    });
    await insertLegacyOutput({
      createdAt: migratedAt - 1,
      db,
      eventId: "evt_skip_4_previewed",
      itemKind: "commandExecution",
      output,
      outputPath: "aggregatedOutput",
      sequence: 4,
      threadId: thread.id,
      truncation: { aggregatedOutput: { originalLength: output.length } },
    });

    expect(await migrateCommandOutput(db, migratedAt)).toEqual({
      action: "scanned",
      eventId: null,
      migratedBytes: 0,
      migratedRows: 0,
      retained: false,
      scanRows: 4,
      threadId: null,
    });
    expect(await db.select().from(retainedEventOutputs).all()).toEqual([]);
    await db.close();
  });

  it.skipIf(isPostgresTest)(
    "advances past a byte-large value below the UTF-16 threshold across restart",
    async () => {
      const migratedAt = 1_800_000_000_000;
      const setupResult = await setup();
      await insertLegacyOutput({
        createdAt: migratedAt - 2,
        db: setupResult.db,
        eventId: "evt_multibyte_below_threshold",
        itemKind: "commandExecution",
        output: "é".repeat(20_000),
        outputPath: "aggregatedOutput",
        sequence: 1,
        threadId: setupResult.thread.id,
      });
      await insertLegacyOutput({
        createdAt: migratedAt - 1,
        db: setupResult.db,
        eventId: "evt_after_multibyte",
        itemKind: "commandExecution",
        output: "a".repeat(40_000),
        outputPath: "aggregatedOutput",
        sequence: 2,
        threadId: setupResult.thread.id,
      });

      expect(
        await migrateCommandOutput(setupResult.db, migratedAt),
      ).toMatchObject({
        action: "scanned",
        migratedRows: 0,
      });
      const serialized = setupResult.db.$client.serialize();
      await setupResult.db.close();

      const restarted = await createConnection(serialized);
      expect(await migrateCommandOutput(restarted, migratedAt)).toMatchObject({
        action: "migrated",
        eventId: "evt_after_multibyte",
        migratedRows: 1,
      });
      expect(
        await restarted.select().from(retainedEventOutputs).all(),
      ).toHaveLength(1);
      await restarted.close();
    },
  );

  it.skipIf(isPostgresTest)(
    "persists and reuses a bounded scan window across advances and restart",
    async () => {
      const migratedAt = 1_800_000_000_000;
      const output = "window-" + "v".repeat(40_000);
      const setupResult = await setup();
      for (let sequence = 1; sequence <= 20; sequence += 1) {
        await insertLegacyOutput({
          createdAt: migratedAt - 1,
          db: setupResult.db,
          eventId: `evt_window_${String(sequence).padStart(2, "0")}`,
          itemKind: "commandExecution",
          output: `${sequence}-${output}`,
          outputPath: "aggregatedOutput",
          sequence,
          threadId: setupResult.thread.id,
        });
      }

      expect(
        await migrateCommandOutput(setupResult.db, migratedAt),
      ).toMatchObject({
        eventId: "evt_window_01",
        scanRows: 10,
      });
      const serialized = setupResult.db.$client.serialize();
      await setupResult.db.close();

      const restarted = await createConnection(serialized);
      expect(await migrateCommandOutput(restarted, migratedAt)).toMatchObject({
        eventId: "evt_window_02",
        scanRows: 0,
      });
      expect(
        await restarted.select().from(retainedEventOutputs).all(),
      ).toHaveLength(2);
      await restarted.close();
    },
  );

  it("stores completion permanently instead of rescanning completed history", async () => {
    const migratedAt = 1_800_000_000_000;
    const output = "w".repeat(40_000);
    const { db, thread } = await setup();
    await insertLegacyOutput({
      createdAt: migratedAt - 1,
      db,
      eventId: "evt_wrap_later",
      itemKind: "commandExecution",
      output,
      outputPath: "aggregatedOutput",
      sequence: 1,
      threadId: thread.id,
    });
    expect((await migrateCommandOutput(db, migratedAt)).eventId).toBe(
      "evt_wrap_later",
    );
    expect((await migrateCommandOutput(db, migratedAt)).action).toBe(
      "complete",
    );
    expect(
      await migrateCommandOutput(db, migratedAt + 7 * 24 * 60 * 60 * 1_000),
    ).toMatchObject({ action: "complete", scanRows: 0 });
    await insertLegacyOutput({
      createdAt: migratedAt - 2,
      db,
      eventId: "evt_wrap_earlier",
      itemKind: "commandExecution",
      output,
      outputPath: "aggregatedOutput",
      sequence: 2,
      threadId: thread.id,
    });
    expect(
      await migrateCommandOutput(db, migratedAt + 30 * 24 * 60 * 60 * 1_000),
    ).toMatchObject({ action: "complete", scanRows: 0 });
    expect(await db.select().from(retainedEventOutputs).all()).toHaveLength(1);
    expect(
      (await db.select().from(maintenanceScanCursors).all())[0]?.lastCreatedAt,
    ).toBe(-1);
    await db.close();
  });

  it("skips oversized legacy rows and continues to the next bounded candidate", async () => {
    const migratedAt = 1_800_000_000_000;
    const { db, thread } = await setup();
    const oversizedOutput = "o".repeat(8 * 1024 * 1024);
    await insertLegacyOutput({
      createdAt: migratedAt - 2,
      db,
      eventId: "evt_oversized_inline",
      itemKind: "commandExecution",
      output: oversizedOutput,
      outputPath: "aggregatedOutput",
      sequence: 1,
      threadId: thread.id,
    });
    await insertLegacyOutput({
      createdAt: migratedAt - 1,
      db,
      eventId: "evt_bounded_after_oversized",
      itemKind: "commandExecution",
      output: "b".repeat(40_000),
      outputPath: "aggregatedOutput",
      sequence: 2,
      threadId: thread.id,
    });

    expect(await migrateCommandOutput(db, migratedAt)).toMatchObject({
      action: "migrated",
      eventId: "evt_bounded_after_oversized",
      migratedRows: 1,
    });
    expect(await db.select().from(retainedEventOutputs).all()).toHaveLength(1);
    const oversized = (
      await listStoredEventRows(db, { threadId: thread.id })
    ).find((row) => row.id === "evt_oversized_inline");
    expect(JSON.parse(oversized?.data ?? "").item.aggregatedOutput).toBe(
      oversizedOutput,
    );
    await db.close();
  });

  it("does not reuse the superseded bulk truncation cursor", async () => {
    const migratedAt = 1_800_000_000_000;
    const { db, thread } = await setup();
    await db
      .insert(maintenanceScanCursors)
      .values({
        id: "completed_event_output_truncation:v1:commandExecution:aggregatedOutput",
        itemKind: "commandExecution",
        lastCreatedAt: migratedAt,
        lastEventId: "z",
        outputPath: "aggregatedOutput",
        policy: "completed_event_output_truncation",
        updatedAt: migratedAt,
        version: 1,
      })
      .run();
    await insertLegacyOutput({
      createdAt: migratedAt - 1,
      db,
      eventId: "evt_new_cursor",
      itemKind: "commandExecution",
      output: "c".repeat(40_000),
      outputPath: "aggregatedOutput",
      sequence: 1,
      threadId: thread.id,
    });

    expect((await migrateCommandOutput(db, migratedAt)).eventId).toBe(
      "evt_new_cursor",
    );
    expect(await db.select().from(maintenanceScanCursors).all()).toHaveLength(
      2,
    );
    await db.close();
  });

  it("sidecarizes a legacy Codex image result without rewriting its event envelope", async () => {
    const migratedAt = 1_800_000_000_000;
    const output = "image-result-" + "i".repeat(4 * 1024 * 1024);
    const { db, thread } = await setup();
    await insertLegacyImageGeneration({
      createdAt: migratedAt - 1,
      db,
      eventId: "evt_legacy_image_generation",
      output,
      sequence: 1,
      threadId: thread.id,
    });

    expect(await migrateLegacyImageGeneration(db, migratedAt)).toMatchObject({
      action: "migrated",
      eventId: "evt_legacy_image_generation",
      migratedRows: 1,
      retained: true,
      threadId: thread.id,
    });
    const [stored] = await listStoredEventRows(db, { threadId: thread.id });
    if (!stored) {
      throw new Error("Expected migrated legacy image generation event");
    }
    expect(stored.type).toBe("provider/unhandled");
    expect(stored.itemKind).toBeNull();
    expect(readLegacyImageGenerationOutput(stored.data)).not.toBe(output);
    const [hydrated] = await hydrateRetainedEventOutputRowsWithinDataByteLimit(
      db,
      [stored],
      8 * 1024 * 1024,
      migratedAt,
    );
    expect(hydrated && readLegacyImageGenerationOutput(hydrated.data)).toBe(
      output,
    );
    expect(
      JSON.parse(hydrated?.data ?? "{}").rawEvent.params.item.truncation,
    ).toBeUndefined();
    await db.close();
  });

  it.skipIf(isPostgresTest)(
    "resumes legacy image migration one row at a time with independent cursor state",
    async () => {
      const migratedAt = 1_800_000_000_000;
      const setupResult = await setup();
      for (const sequence of [1, 2]) {
        await insertLegacyImageGeneration({
          createdAt: migratedAt - 1,
          db: setupResult.db,
          eventId: `evt_legacy_image_restart_${sequence}`,
          output: `${sequence}-` + "r".repeat(40_000),
          sequence,
          threadId: setupResult.thread.id,
        });
      }
      expect(
        await migrateLegacyImageGeneration(setupResult.db, migratedAt),
      ).toMatchObject({
        action: "migrated",
        eventId: "evt_legacy_image_restart_1",
        migratedRows: 1,
      });
      const serialized = setupResult.db.$client.serialize();
      await setupResult.db.close();

      const restarted = await createConnection(serialized);
      expect(
        await migrateLegacyImageGeneration(restarted, migratedAt),
      ).toMatchObject({
        action: "migrated",
        eventId: "evt_legacy_image_restart_2",
        migratedRows: 1,
      });
      expect(
        await restarted.select().from(retainedEventOutputs).all(),
      ).toHaveLength(2);
      expect(
        (await restarted.select().from(maintenanceScanCursors).all()).every(
          (cursor) => cursor.policy.startsWith("legacy_image_generation"),
        ),
      ).toBe(true);
      await restarted.close();
    },
  );

  it.skipIf(isPostgresTest)(
    "bounds a sparse legacy image scan by all event rows across restart",
    async () => {
      const migratedAt = 1_800_000_000_000;
      const setupResult = await setup();
      for (const sequence of [1, 2]) {
        await insertLegacyOutput({
          createdAt: migratedAt - sequence,
          db: setupResult.db,
          eventId: `evt_0${sequence}_unrelated`,
          itemKind: "commandExecution",
          output: "small",
          outputPath: "aggregatedOutput",
          sequence,
          threadId: setupResult.thread.id,
        });
      }
      await insertLegacyImageGeneration({
        createdAt: migratedAt - 10_000,
        db: setupResult.db,
        eventId: "evt_03_legacy_image",
        output: "image-" + "i".repeat(40_000),
        sequence: 3,
        threadId: setupResult.thread.id,
      });

      expect(
        await migrateNextLegacyImageGenerationOutput(setupResult.db, {
          limit: 2,
          migratedAt,
        }),
      ).toMatchObject({ action: "scanned", migratedRows: 0, scanRows: 2 });
      const serialized = setupResult.db.$client.serialize();
      await setupResult.db.close();

      const restarted = await createConnection(serialized);
      expect(
        await migrateNextLegacyImageGenerationOutput(restarted, {
          limit: 2,
          migratedAt,
        }),
      ).toMatchObject({
        action: "migrated",
        eventId: "evt_03_legacy_image",
        migratedRows: 1,
        scanRows: 1,
      });
      await restarted.close();
    },
  );

  it("drops expired legacy image results and skips unrelated unhandled events", async () => {
    const migratedAt = 1_800_000_000_000;
    const { db, thread } = await setup();
    await insertLegacyImageGeneration({
      createdAt: migratedAt - COMPLETED_EVENT_OUTPUT_RETENTION_MS,
      db,
      eventId: "evt_expired_legacy_image",
      output: "expired-" + "e".repeat(40_000),
      sequence: 1,
      threadId: thread.id,
    });
    const malformedData = JSON.stringify({
      providerId: "codex",
      rawEvent: {
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          item: {
            failure: null,
            id: "malformed-image",
            result: "malformed-" + "m".repeat(40_000),
            revisedPrompt: "Malformed future status",
            status: "futureStatus",
            type: "imageGeneration",
          },
        },
      },
      rawType: "item/completed",
    });
    await db
      .insert(events)
      .values({
        createdAt: migratedAt - 1,
        data: malformedData,
        id: "evt_malformed_image",
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        providerThreadId: "codex-thread",
        scopeKind: "turn",
        sequence: 2,
        threadId: thread.id,
        turnId: "turn-unrelated",
        type: "provider/unhandled",
      })
      .run();

    expect(await migrateLegacyImageGeneration(db, migratedAt)).toMatchObject({
      action: "migrated",
      eventId: "evt_expired_legacy_image",
      retained: false,
    });
    expect(await db.select().from(retainedEventOutputs).all()).toEqual([]);
    expect((await migrateLegacyImageGeneration(db, migratedAt)).action).toBe(
      "scanned",
    );
    expect(
      (
        await db
          .select({ data: events.data })
          .from(events)
          .where(eq(events.id, "evt_malformed_image"))
          .get()
      )?.data,
    ).toBe(malformedData);
    await db.close();
  });

  it.skipIf(isPostgresTest)(
    "advances past a malformed legacy image candidate across restart",
    async () => {
      const migratedAt = 1_800_000_000_000;
      const setupResult = await setup();
      const malformedData = JSON.stringify({
        providerId: "codex",
        rawEvent: {
          jsonrpc: "2.0",
          method: "item/completed",
          params: {
            item: {
              failure: null,
              id: "malformed-image",
              result: "malformed-" + "m".repeat(40_000),
              status: "futureStatus",
              type: "imageGeneration",
            },
          },
        },
        rawType: "item/completed",
      });
      await setupResult.db
        .insert(events)
        .values({
          createdAt: migratedAt - 2,
          data: malformedData,
          id: "evt_malformed_image_before_valid",
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          providerThreadId: "codex-thread",
          scopeKind: "turn",
          sequence: 1,
          threadId: setupResult.thread.id,
          turnId: "turn-malformed-image",
          type: "provider/unhandled",
        })
        .run();
      await insertLegacyImageGeneration({
        createdAt: migratedAt - 1,
        db: setupResult.db,
        eventId: "evt_valid_image_after_malformed",
        output: "valid-" + "v".repeat(40_000),
        sequence: 2,
        threadId: setupResult.thread.id,
      });

      expect(
        await migrateLegacyImageGeneration(setupResult.db, migratedAt),
      ).toMatchObject({ action: "scanned", migratedRows: 0 });
      const serialized = setupResult.db.$client.serialize();
      await setupResult.db.close();

      const restarted = await createConnection(serialized);
      expect(
        await migrateLegacyImageGeneration(restarted, migratedAt),
      ).toMatchObject({
        action: "migrated",
        eventId: "evt_valid_image_after_malformed",
        migratedRows: 1,
      });
      expect(
        await restarted.select().from(retainedEventOutputs).all(),
      ).toHaveLength(1);
      await restarted.close();
    },
  );
});
