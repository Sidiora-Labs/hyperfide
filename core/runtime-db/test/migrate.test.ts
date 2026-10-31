// These checks exercise native SQLite metadata, locks, triggers or query plans.
import { isPostgresTest } from "../src/testing.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishedMigrationWhensByTag } from "../src/migration-history.js";
import {
  dropPluginEnabledFollowsDefaultColumn,
  dropIdleLifecycleIndexes,
  rewindThreadPruningWork,
  dropMarketplaceSourceGitSubdirectoryColumn,
  dropThreadParentNotificationsColumn,
  dropQueuedMessageEditHeldUntilColumn,
  rewindQueuedMessageStateMigration,
} from "./helpers/rewind.js";
import { defaultAppSettings } from "@hyperfide/domain";
import {
  createQueuedThreadMessage,
  createThread,
  createConnection,
  createProject,
  getAppKeybindingOverrides,
  getAppSettings,
  migrate,
  noopNotifier,
  upsertHost,
  type DbConnection,
  type MigrationWarningLogger,
} from "../src/index.js";
import {
  createMigratedConnection,
  prepareMigratedConnectionTemplate,
} from "../src/testing.js";

type InsertMigrationParameters = [string, number];
type DeleteMigrationParameters = [number];
type DeleteMigrationsParameters = [number, number, number, number];
type TableNameParameters = [string];
type QueuedMessageMigrationInsertParameters = [string, string, number, number];
type ProjectSortKeyMigrationInsertParameters = [string, string, number, number];
type ThreadSortKeyMigrationInsertParameters = [string, string, string, number];

interface IndexNameRow {
  name: string;
}

interface TableNameRow {
  name: string;
}

interface MigrationCreatedAtRow {
  createdAt: number;
}

interface LatestMigrationCreatedAtRow {
  createdAt: number | null;
}

interface MigratedQueuedMessageRow {
  id: string;
  sortKey: string;
  threadId: string;
}

interface MigratedPermissionModeRow {
  id: string;
  permissionMode: string;
}

interface MigratedProjectRow {
  id: string;
  sortKey: string;
}

interface MigratedThreadOriginRow {
  id: string;
  originKind: string | null;
  originPluginId: string | null;
  visibility: string;
}

interface MigratedThreadSortKeyRow {
  id: string;
  sortKey: string | null;
}

interface MigratedManagerCleanupDefaultRow {
  model: string;
  permissionMode: string;
  providerId: string;
  reasoningLevel: string;
  serviceTier: string;
}

interface MigratedManagerCleanupThreadRow {
  id: string;
  parentThreadId: string | null;
}

interface MigratedThreadProvenanceRow {
  id: string;
  originKind: string | null;
  parentThreadId: string | null;
  sourceThreadId: string | null;
}

interface BackfilledEnvironmentRow {
  id: string;
  environmentProviderId: string | null;
  environmentProviderSelection: string | null;
  environmentProviderInstanceKey: string | null;
}

interface MigratedThreadVisibilityRow {
  id: string;
  visibility: string;
}

interface OperationBackfillProjectRow {
  deletedAt: number | null;
}

interface OperationBackfillEnvironmentRow {
  status: string;
}

interface OperationBackfillThreadRow {
  status: string;
}

interface MigratedEventRow {
  createdAt: number;
  data: string;
  environmentId: string | null;
  id: string;
  itemId: string | null;
  itemKind: string | null;
  providerThreadId: string | null;
  scopeKind: string;
  sequence: number;
  threadId: string;
  turnId: string | null;
  type: string;
}

interface MigratedEventDataRow {
  data: string;
}

interface MigratedEventParentRow {
  id: string;
  parentToolCallId: string | null;
}

interface MigratedExperimentRow {
  key: string;
  updatedAt: number;
  value: number;
}

interface MigratedPendingInteractionStatusRow {
  id: string;
  resolvedAt: number | null;
  status: string;
  statusReason: string | null;
  updatedAt: number;
}

interface MigratedPendingInteractionEventStatusRow {
  id: string;
  status: string | null;
  statusReason: string | null;
}

interface PersonalProjectMigrationRow {
  count: number;
}

interface MigrationCountRow {
  count: number;
}

interface MigratedPluginCatalogProvenanceRow {
  id: string;
  provenance: string;
  catalogEntryId: string | null;
}

interface MigratedNamedCatalogProvenanceRow {
  id: string;
  catalogMarketplaceName: string | null;
}

interface MigratedPluginCatalogRow {
  catalogJson: string;
  lastAttemptedRefreshAt: number | null;
}

interface TableInfoRow {
  name: string;
  notnull: number;
}

interface ForeignKeyRow {
  childColumn: string;
  onDelete: string;
  parentColumn: string;
  parentTable: string;
}

interface ReadIndexNamesArgs {
  db: DbConnection;
  tableName: string;
}

interface ReplaceAppliedMigrationHashArgs {
  db: DbConnection;
  createdAt: number;
  hash: string;
}

interface RunMigrationFileArgs {
  db: DbConnection;
  migrationPath: string;
}

interface SeedEventLargeValueBackfillEventArgs {
  createdAt: number;
  data: string;
  id: string;
  itemId: string;
  itemKind: string;
  sequence: number;
  type?: string;
}

interface SeededLargeValueBackfillValues {
  commandOutput: string;
  firstDiff: string;
  secondDiff: string;
  toolResult: { body: string };
  webFetchResult: string;
  webSearchResult: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const latestMigrationWhen = Math.max(
  ...(
    JSON.parse(
      readFileSync(
        resolve(__dirname, "../drizzle/meta/_journal.json"),
        "utf-8",
      ),
    ) as { entries: { when: number }[] }
  ).entries.map((entry) => entry.when),
);

async function restoreWideExperimentsTable(db: DbConnection): Promise<void> {
  const columns = await db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(system_experiments)")
    .all();
  if (!columns.some((column) => column.name === "key")) return;

  await db.$client.exec(`
    CREATE TABLE __wide_system_experiments (
      id text PRIMARY KEY NOT NULL,
      claude_code_mock_cli_traffic integer NOT NULL,
      new_onboarding integer DEFAULT false NOT NULL,
      tools_hub integer DEFAULT false NOT NULL,
      updated_at integer NOT NULL
    );
    INSERT INTO __wide_system_experiments (
      id,
      claude_code_mock_cli_traffic,
      new_onboarding,
      tools_hub,
      updated_at
    ) VALUES (
      'current',
      COALESCE((SELECT value FROM system_experiments WHERE key = 'claudeCodeMockCliTraffic'), false),
      COALESCE((SELECT value FROM system_experiments WHERE key = 'newOnboarding'), false),
      COALESCE((SELECT value FROM system_experiments WHERE key = 'toolsHub'), false),
      COALESCE((SELECT MAX(updated_at) FROM system_experiments), 0)
    );
    DROP TABLE system_experiments;
    ALTER TABLE __wide_system_experiments RENAME TO system_experiments;
  `);
}

async function dropAppSettingsValuesTable(db: DbConnection): Promise<void> {
  await db.$client.prepare("DROP TABLE IF EXISTS app_settings_values").run();
}

async function dropThreadConversationOutlinesTable(
  db: DbConnection,
): Promise<void> {
  await db.$client
    .prepare("DROP TABLE IF EXISTS thread_conversation_outlines")
    .run();
}

async function dropRewindAddedTables(db: DbConnection): Promise<void> {
  await rewindEnvironmentRowFactsMigration(db);
  await rewindEnvironmentProvidersMigration(db);
  await dropThreadConversationOutlinesTable(db);
  await db.$client.prepare("DROP TABLE IF EXISTS thread_tabs").run();
  await db.$client.prepare("DROP TABLE IF EXISTS automation_runs").run();
  await db.$client.prepare("DROP TABLE IF EXISTS automations").run();
  await db.$client.prepare("DROP TABLE IF EXISTS app_theme").run();
  await db.$client.prepare("DROP TABLE IF EXISTS app_settings").run();
  await dropAppSettingsValuesTable(db);
  await db.$client.prepare("DROP TABLE IF EXISTS plugin_state_snapshots").run();
  await db.$client.prepare("DROP TABLE IF EXISTS plugin_artifacts").run();
  await db.$client.prepare("DROP TABLE IF EXISTS plugin_catalog").run();
  await db.$client.prepare("DROP TABLE IF EXISTS marketplaces").run();
  await dropMarketplaceCatalogSchema(db);
  await dropEventParentToolCallIdColumn(db);
  await dropQueueReworkSchema(db);
  await db.$client.prepare("DROP TABLE IF EXISTS plugins").run();
  await db.$client.prepare("DROP TABLE IF EXISTS plugin_kv").run();
  await db.$client.prepare("DROP TABLE IF EXISTS plugin_settings").run();
  await db.$client.prepare("DROP TABLE IF EXISTS plugin_schedules").run();
  await db.$client
    .prepare("ALTER TABLE hosts DROP COLUMN last_rejected_protocol_version")
    .run();
  await dropHostMaxPermissionModeColumn(db);
  await dropEnvironmentRetireRequestedAtColumn(db);
  await dropPluginArtifactGitCheckoutRootColumn(db);
  await dropThreadSectionSchema(db);
  await restoreWideExperimentsTable(db);
  const experimentColumns = new Set(
    (
      await db.$client
        .prepare<[], TableInfoRow>("PRAGMA table_info(system_experiments)")
        .all()
    ).map((column) => column.name),
  );
  if (experimentColumns.has("plugins")) {
    await db.$client
      .prepare("ALTER TABLE system_experiments DROP COLUMN plugins")
      .run();
  }
  if (experimentColumns.has("hyperfide_connect")) {
    await db.$client
      .prepare("ALTER TABLE system_experiments DROP COLUMN hyperfide_connect")
      .run();
  }
  if (experimentColumns.has("multi_machine")) {
    await db.$client
      .prepare("ALTER TABLE system_experiments DROP COLUMN multi_machine")
      .run();
  }
  if (experimentColumns.has("thread_splits")) {
    await db.$client
      .prepare("ALTER TABLE system_experiments DROP COLUMN thread_splits")
      .run();
  }
  await dropSideChatPluginExperimentColumn(db);
  await dropToolsHubExperimentColumn(db);
  await dropNewOnboardingExperimentColumn(db);
  await dropSteerActiveThreadOnEnterColumn(db);
  await dropOnboardingCompletedAtColumn(db);
  await db.$client.prepare("ALTER TABLE threads DROP COLUMN visibility").run();
  await db.$client.exec(
    "DROP INDEX IF EXISTS `threads_origin_plugin_archived_idx`",
  );
  await db.$client
    .prepare("ALTER TABLE threads DROP COLUMN origin_plugin_id")
    .run();
  await dropProjectGitRemoteUrlColumn(db);
}

function requirePublishedMigrationWhen(tag: string): number {
  const when = publishedMigrationWhensByTag.get(tag);
  if (when === undefined) {
    throw new Error(`No published migration timestamp for ${tag}`);
  }

  return when;
}
const closedSessionPruneIndexesWhen = requirePublishedMigrationWhen(
  "0002_closed_session_prune_indexes",
);
const threadPinningMigrationWhen = 1779990051923;
const operationStateBackfillMigrationWhen = 1780687798957;
const eventProducerColumnsMigrationWhen = 1780692763264;
const terminalSessionRuntimeStateHonestyWhen = 1780718665310;
const hostDaemonSessionObservabilityMigrationWhen = 1780719536955;
const threadTypeRemovalMigrationWhen = 1780973302146;
const threadSearchMigrationWhen = 1781660000001;
const threadSearchRowidFtsMigrationWhen = 1781660000002;
const rowidThreadSearchMigrationHash =
  "025358fe89253aec7f5bd970dc3eb88d0e834f0d58fb9d75329a5d39899340f4";
const legacyExperimentsMigrationWhen = 1781299832942;
const environmentProvisioningMigrationWhen = 1789075667774;
const machineProvidersMigrationWhen = 1789081162875;
const eventLargeValuesMigrationWhen = 1781403656069;
const eventLargeValuesRestoreMigrationWhen = 1781557200000;
const cleanupModeDropMigrationWhen = 1781557300000;
const stopRequestedAtDropMigrationWhen = 1781557400000;
const cleanupRequestedAtDropMigrationWhen = 1781557500000;
const threadSourceOriginMigrationWhen = 1781660000000;
const threadSectionsRepairMigrationWhen = 1784257485616;
const permissionModesMigrationWhen = 1784311522462;
const eventParentToolCallMigrationWhen = 1787181956957;
const eventParentToolCallPreJsonValidMigrationHash =
  "79d39e7b68d1db8ba02614fe4cc227cc0c154d77c7183f2e37ed2d8475412993";
const eventLargeValuesPreOptimizationHash =
  "bc111f5134183c37cf135af70231ec5a79823f9868818fdd8377e1ab3c05a23f";
const queuedMessageSortKeyMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0004_wild_justice.sql",
);
const pluginCatalogMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0072_bizarre_the_liberteens.sql",
);
const sideChatVisibilityBackfillMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0079_side_chat_plugin.sql",
);
const sideChatPluginOnlyMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0084_side_chat_plugin_only.sql",
);
const experimentKeyValueMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0090_equal_reaper.sql",
);
const appSettingsKeyValueMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0102_app_settings_key_value.sql",
);
const steerOnEnterDefaultMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0112_steer_on_enter_default.sql",
);
const stampOnboardingMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0140_stamp_onboarding_existing_installs.sql",
);
const retainedEventOutputsMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0114_public_iron_lad.sql",
);
const providerSettingsToPluginsMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0105_provider_settings_to_plugins.sql",
);
const retireRequestedAtMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0091_daffy_dark_phoenix.sql",
);
const pluginArtifactCheckoutRootMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0094_mighty_polaris.sql",
);
const namedMarketplaceCatalogMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0095_normal_elektra.sql",
);
const curatedMarketplaceRenameMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0098_rename_curated_marketplace.sql",
);
const providerUsagePluginIdMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0135_rename_provider_usage_plugin_id.sql",
);
const sidebarOrderingMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0005_strong_exodus.sql",
);
const threadPinningMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0008_thread_pinning.sql",
);
const pendingInteractionSchemaHonestyMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0019_pending_interactions_schema_honesty.sql",
);
const eventLargeValuesMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0031_mysterious_zaran.sql",
);
const machineProvidersMigrationPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "0117_machine_providers.sql",
);
async function closeConnection(db: DbConnection): Promise<void> {
  await db.close();
}

async function restoreSideChatPluginExperimentColumn(
  db: DbConnection,
): Promise<void> {
  const columns = await db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(system_experiments)")
    .all();
  if (!columns.some((column) => column.name === "side_chat_plugin")) {
    await db.$client.exec(
      "ALTER TABLE `system_experiments` ADD `side_chat_plugin` integer DEFAULT false NOT NULL",
    );
  }
}

async function dropSideChatPluginExperimentColumn(
  db: DbConnection,
): Promise<void> {
  const columns = await db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(system_experiments)")
    .all();
  if (columns.some((column) => column.name === "side_chat_plugin")) {
    await db.$client
      .prepare("ALTER TABLE system_experiments DROP COLUMN side_chat_plugin")
      .run();
  }
}

async function restoreLegacyThreadOriginColumn(
  db: DbConnection,
): Promise<void> {
  const columns = await db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(threads)")
    .all();
  if (!columns.some((column) => column.name === "child_origin")) {
    await db.$client
      .prepare("ALTER TABLE threads ADD COLUMN child_origin text")
      .run();
  }
}

async function restorePluginsExperimentColumn(db: DbConnection): Promise<void> {
  const columns = await db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(system_experiments)")
    .all();
  if (!columns.some((column) => column.name === "plugins")) {
    await db.$client
      .prepare(
        "ALTER TABLE system_experiments ADD `plugins` integer DEFAULT false NOT NULL",
      )
      .run();
  }
}

async function dropToolsHubExperimentColumn(db: DbConnection): Promise<void> {
  const columns = await db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(system_experiments)")
    .all();
  if (columns.some((column) => column.name === "tools_hub")) {
    await db.$client
      .prepare("ALTER TABLE system_experiments DROP COLUMN tools_hub")
      .run();
  }
}

async function dropNewOnboardingExperimentColumn(
  db: DbConnection,
): Promise<void> {
  const columns = await db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(system_experiments)")
    .all();
  if (columns.some((column) => column.name === "new_onboarding")) {
    await db.$client
      .prepare("ALTER TABLE system_experiments DROP COLUMN new_onboarding")
      .run();
  }
}

async function dropHostMaxPermissionModeColumn(
  db: DbConnection,
): Promise<void> {
  const columns = await db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(hosts)")
    .all();
  if (columns.some((column) => column.name === "max_permission_mode")) {
    await db.$client
      .prepare("ALTER TABLE hosts DROP COLUMN max_permission_mode")
      .run();
  }
}

async function dropSteerActiveThreadOnEnterColumn(
  db: DbConnection,
): Promise<void> {
  const columns = await db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(app_settings)")
    .all();
  if (
    columns.some((column) => column.name === "steer_active_thread_on_enter")
  ) {
    await db.$client
      .prepare(
        "ALTER TABLE app_settings DROP COLUMN steer_active_thread_on_enter",
      )
      .run();
  }
}

async function dropOnboardingCompletedAtColumn(
  db: DbConnection,
): Promise<void> {
  const columns = await db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(app_settings)")
    .all();
  if (columns.some((column) => column.name === "onboarding_completed_at")) {
    await db.$client
      .prepare("ALTER TABLE app_settings DROP COLUMN onboarding_completed_at")
      .run();
  }
}

async function resetMigrationsAfterThreadSearch(
  db: DbConnection,
): Promise<void> {
  await restoreLegacyThreadOriginColumn(db);
  await dropRewindAddedTables(db);
  await db.$client
    .prepare<[number]>("DELETE FROM __drizzle_migrations WHERE created_at > ?")
    .run(threadSearchRowidFtsMigrationWhen);
}

async function dropMarketplaceCatalogSchema(db: DbConnection): Promise<void> {
  await db.$client
    .prepare("DROP TABLE IF EXISTS plugin_marketplace_icons")
    .run();
  await db.$client.prepare("DROP TABLE IF EXISTS plugin_marketplaces").run();
  const columns = new Set(
    (
      await db.$client
        .prepare<[], TableInfoRow>("PRAGMA table_info(plugins)")
        .all()
    ).map((column) => column.name),
  );
  for (const column of [
    "catalog_marketplace_name",
    "source_git_range",
    "source_git_tag_prefix",
    "source_git_resolved_tag",
  ]) {
    if (columns.has(column)) {
      await db.$client
        .prepare(`ALTER TABLE plugins DROP COLUMN ${column}`)
        .run();
    }
  }
}

async function dropEventToolNameColumn(db: DbConnection): Promise<void> {
  await db.$client
    .prepare("DROP TABLE IF EXISTS provider_model_catalogs")
    .run();
  await db.$client.prepare("DROP TABLE IF EXISTS ui_preference_defaults").run();
  await db.$client.prepare("DROP TABLE IF EXISTS ui_preferences").run();
  await db.$client.prepare("DROP TABLE IF EXISTS retained_event_outputs").run();
  await dropThreadConversationOutlinesTable(db);
  await db.$client.exec(
    "DROP INDEX IF EXISTS events_delegating_item_lookup_idx",
  );
  await db.$client.exec(
    "DROP INDEX IF EXISTS events_plan_steps_thread_sequence_idx",
  );
  // The same rewind also rewinds the later deferred-message table (0108).
  await db.$client
    .prepare("DROP TABLE IF EXISTS deferred_thread_messages")
    .run();
  // Generated columns are omitted from table_info but included in table_xinfo.
  const columns = await db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_xinfo(events)")
    .all();
  if (columns.some((column) => column.name === "tool_name")) {
    await db.$client.exec(
      "DROP INDEX IF EXISTS events_todo_tool_call_thread_tool_sequence_idx",
    );
    await db.$client.prepare("ALTER TABLE events DROP COLUMN tool_name").run();
  }
}

async function dropEventParentToolCallIdColumn(
  db: DbConnection,
): Promise<void> {
  await dropEventToolNameColumn(db);
  const columns = await db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(events)")
    .all();
  if (columns.some((column) => column.name === "parent_tool_call_id")) {
    await db.$client.exec(
      "DROP INDEX IF EXISTS events_parent_tool_call_thread_parent_sequence_idx",
    );
    await db.$client
      .prepare("ALTER TABLE events DROP COLUMN parent_tool_call_id")
      .run();
  }
}

async function dropMarketplaceStatsColumn(db: DbConnection): Promise<void> {
  const columns = await db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(plugin_marketplaces)")
    .all();
  if (columns.some((column) => column.name === "stats_json")) {
    await db.$client
      .prepare("ALTER TABLE plugin_marketplaces DROP COLUMN stats_json")
      .run();
  }
}

/**
 * Undo migration 0110, the dispatch-queue rework.
 *
 * 0110 adds the queue's wait columns (schedule, typed wait, wait holder,
 * payload kind and its retry reference), the system-notice and failure-reason
 * sidecars, their two partial indexes, and the thread's pending start
 * context.
 * A rewind that clears its journal row must remove all of them before the
 * replay's ADDs hit a table that already has them.
 *
 * The table 0110 DROPs (`deferred_thread_messages`, added by 0108) needs
 * nothing here. Every rewind that clears 0110's journal row also clears
 * 0108's, so the replay recreates the table before 0110 drops it again.
 */
async function rewindEnvironmentProvisioningMigration(
  db: DbConnection,
): Promise<void> {
  dropIdleLifecycleIndexes(db);
  await rewindThreadPruningWork(db);
  await dropPluginEnabledFollowsDefaultColumn(db);
  await dropQueuedMessageEditHeldUntilColumn(db);
  await dropMarketplaceSourceGitSubdirectoryColumn(db);
  await dropThreadParentNotificationsColumn(db);
  await db.$client.exec(
    "DROP TRIGGER IF EXISTS threads_lifecycle_owner_insert",
  );
  await db.$client.exec(
    "DROP TRIGGER IF EXISTS threads_lifecycle_owner_immutable",
  );
  await db.$client.exec("DROP INDEX IF EXISTS threads_lifecycle_owner_idx");
  await db.$client.exec(
    "DROP INDEX IF EXISTS environments_provider_lifecycle_idx",
  );
  if (
    (
      await db.$client
        .prepare<[], TableInfoRow>("PRAGMA table_info(threads)")
        .all()
    ).some((column) => column.name === "lifecycle_owner_thread_id")
  ) {
    await db.$client.exec(
      "ALTER TABLE threads DROP COLUMN lifecycle_owner_thread_id",
    );
  }
  const columns = await db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(environments)")
    .all();
  for (const name of [
    "environments_owner_thread_idx",
    "environments_claim_idx",
  ])
    await db.$client.exec(`DROP INDEX IF EXISTS ${name}`);
  for (const column of columns) {
    if (
      [
        "owner_thread_id",
        "attempt",
        "claim_path",
        "status_message",
        "pending_log",
      ].includes(column.name) ||
      column.name === "replaced_environment_id"
    )
      await db.$client.exec(
        `ALTER TABLE environments DROP COLUMN ${column.name}`,
      );
  }
  const threadColumns = await db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(threads)")
    .all();
  if (threadColumns.some((column) => column.name === "startup_context"))
    await db.$client.exec(
      "ALTER TABLE threads RENAME COLUMN startup_context TO pending_start_context",
    );
}

async function dropQueuedMessageAttemptColumns(
  db: DbConnection,
): Promise<void> {
  await rewindQueuedMessageStateMigration(db);
  await dropThreadParentNotificationsColumn(db);
  const columns = await db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(queued_thread_messages)")
    .all();
  for (const name of ["failure_count", "next_attempt_at"]) {
    if (!columns.some((column) => column.name === name)) continue;
    await db.$client
      .prepare(`ALTER TABLE queued_thread_messages DROP COLUMN ${name}`)
      .run();
  }
}

async function dropQueueReworkSchema(db: DbConnection): Promise<void> {
  await dropQueuedMessageAttemptColumns(db);
  await rewindEnvironmentProvisioningMigration(db);
  // Indexes first: SQLite refuses to drop a column an existing index names.
  for (const index of [
    "queued_thread_messages_due_idx",
    "queued_thread_messages_wait_holder_idx",
  ]) {
    await db.$client.prepare(`DROP INDEX IF EXISTS ${index}`).run();
  }
  const queuedColumns = await db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(queued_thread_messages)")
    .all();
  for (const name of [
    "system_notice",
    "send_at",
    "waiting_on",
    "wait_holder",
    "failure_reason",
    "payload_kind",
    "retry_of_turn_request_id",
    "retry_attempt",
    "retry_reason",
    "origin",
    "origin_plugin_id",
    "requested_by_initiator",
    "requested_by_thread_id",
  ]) {
    if (!queuedColumns.some((column) => column.name === name)) continue;
    await db.$client
      .prepare(`ALTER TABLE queued_thread_messages DROP COLUMN ${name}`)
      .run();
  }
  const threadColumns = await db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(threads)")
    .all();
  if (threadColumns.some((column) => column.name === "pending_start_context")) {
    await db.$client
      .prepare("ALTER TABLE threads DROP COLUMN pending_start_context")
      .run();
  }
}

async function rewindEnvironmentRowFactsMigration(
  db: DbConnection,
): Promise<void> {
  await rewindEnvironmentProvisioningMigration(db);
  const columns = new Set(
    (
      await db.$client
        .prepare<[], TableInfoRow>("PRAGMA table_info(environments)")
        .all()
    ).map((column) => column.name),
  );
  if (columns.has("provider_owns_path")) {
    await db.$client
      .prepare("ALTER TABLE environments DROP COLUMN provider_owns_path")
      .run();
  }
  if (columns.has("is_worktree")) {
    await db.$client
      .prepare("ALTER TABLE environments DROP COLUMN is_worktree")
      .run();
  }
}

async function rewindMachineProvidersMigration(
  db: DbConnection,
): Promise<void> {
  await rewindThreadPruningWork(db);
  await dropQueuedMessageEditHeldUntilColumn(db);
  await dropMarketplaceSourceGitSubdirectoryColumn(db);
  await dropThreadParentNotificationsColumn(db);
  await db.$client.exec("DROP TABLE IF EXISTS ui_preference_defaults");
  const queuedDispatchOrigin = await db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(queued_thread_messages)")
    .all();
  for (const name of [
    "origin",
    "origin_plugin_id",
    "requested_by_initiator",
    "requested_by_thread_id",
  ]) {
    if (!queuedDispatchOrigin.some((column) => column.name === name)) continue;
    await db.$client.exec(
      `ALTER TABLE queued_thread_messages DROP COLUMN ${name}`,
    );
  }
  await db.$client.exec("DROP TABLE IF EXISTS thread_pruning_cursors");
  await db.$client.exec("DROP TABLE IF EXISTS project_attachment_threads");
  await db.$client.exec("DROP TABLE IF EXISTS project_attachments");
  await db.$client.exec("DROP TABLE IF EXISTS project_attachment_backfills");
  await db.$client.exec("DROP INDEX IF EXISTS threads_project_id_idx");
  await db.$client.exec("DROP TABLE IF EXISTS environment_variables");
  await db.$client.exec("DROP TABLE IF EXISTS thread_plugin_metadata");
  await db.$client.exec("DROP TABLE IF EXISTS provider_model_catalogs");
  await db.$client.exec("DROP TABLE IF EXISTS environment_hook_operations");
  if (
    (
      await db.$client
        .prepare<[], TableInfoRow>("PRAGMA table_info(project_sources)")
        .all()
    ).some((column) => column.name === "owns_path")
  ) {
    await db.$client.exec("ALTER TABLE project_sources DROP COLUMN owns_path");
  }
  dropIdleLifecycleIndexes(db);
  await db.$client.exec("DROP INDEX IF EXISTS hosts_live_launch_key_idx");
  for (const column of [
    "machine_provider_id",
    "launch_key",
    "machine_inputs",
    "machine_attempt",
    "pending_log",
    "machine_operation_id",
    "server_access_provider_id",
    "server_access_grant_id",
    "resource",
    "phase",
    "suspended_at",
    "status_message",
    "suspend_retry_at",
    "idle_since",
    "remove_retry_at",
    "teardown_attempt",
    "teardown_status",
  ]) {
    const columns = await db.$client
      .prepare<[], TableInfoRow>("PRAGMA table_info(hosts)")
      .all();
    if (columns.some((entry) => entry.name === column)) {
      await db.$client.exec(`ALTER TABLE hosts DROP COLUMN ${column}`);
    }
  }
  const sessionColumns = await db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(host_daemon_sessions)")
    .all();
  if (!sessionColumns.some((column) => column.name === "host_type")) {
    await db.$client
      .prepare(
        "ALTER TABLE host_daemon_sessions ADD COLUMN host_type text NOT NULL DEFAULT 'persistent'",
      )
      .run();
  }
  await db.$client
    .prepare<[number]>("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
    .run(machineProvidersMigrationWhen);
}

async function rewindEnvironmentProvidersMigration(
  db: DbConnection,
): Promise<void> {
  await rewindMachineProvidersMigration(db);
  await rewindEnvironmentProvisioningMigration(db);
  await db.$client.exec("DROP TABLE IF EXISTS machine_workspace_setups");
  await db.$client.exec("DROP TABLE IF EXISTS environment_setup_outcomes");
  await db.$client.exec("DROP TABLE IF EXISTS environment_launches");
  await db.$client.exec(
    "DROP INDEX IF EXISTS environments_project_host_path_idx",
  );
  const hostColumns = new Set(
    (
      await db.$client
        .prepare<[], TableInfoRow>("PRAGMA table_info(hosts)")
        .all()
    ).map((column) => column.name),
  );
  if (!hostColumns.has("type")) {
    await db.$client
      .prepare(
        "ALTER TABLE hosts ADD COLUMN type text NOT NULL DEFAULT 'persistent'",
      )
      .run();
  }
  const lifecycleColumns = [
    "environment_provider_plugin_id",
    "canonical_path",
    "retire_at",
    "teardown_attempt",
    "teardown_status",
    "teardown_message",
    "resource",
  ];
  for (const column of lifecycleColumns) {
    const columns = await db.$client
      .prepare<[], TableInfoRow>("PRAGMA table_info(environments)")
      .all();
    if (columns.some((entry) => entry.name === column))
      await db.$client.exec(`ALTER TABLE environments DROP COLUMN ${column}`);
  }

  const columns = new Set(
    (
      await db.$client
        .prepare<[], TableInfoRow>("PRAGMA table_info(environments)")
        .all()
    ).map((column) => column.name),
  );
  if (!columns.has("managed")) {
    await db.$client
      .prepare(
        "ALTER TABLE environments ADD COLUMN managed integer NOT NULL DEFAULT 0",
      )
      .run();
  }
  if (!columns.has("destroy_attempt_id")) {
    await db.$client
      .prepare("ALTER TABLE environments ADD COLUMN destroy_attempt_id text")
      .run();
  }
  if (!columns.has("retire_requested_at")) {
    await db.$client
      .prepare(
        "ALTER TABLE environments ADD COLUMN retire_requested_at integer",
      )
      .run();
  }
  if (!columns.has("workspace_provision_type")) {
    await db.$client
      .prepare(
        "ALTER TABLE environments ADD COLUMN workspace_provision_type text NOT NULL DEFAULT 'unmanaged'",
      )
      .run();
  }
  if (!columns.has("is_worktree")) {
    await db.$client
      .prepare(
        "ALTER TABLE environments ADD COLUMN is_worktree integer NOT NULL DEFAULT 0",
      )
      .run();
  }
  if (!columns.has("environment_provider_id")) return;
  await db.$client
    .prepare(
      `UPDATE environments
         SET workspace_provision_type = 'managed-worktree',
             managed = 1,
             base_branch = COALESCE(
               json_extract(environment_provider_selection, '$.inputs.branch.name'),
               base_branch
             )
       WHERE environment_provider_id = 'git-worktree'`,
    )
    .run();
  await db.$client
    .prepare(
      `UPDATE environments
         SET workspace_provision_type = 'personal',
             managed = 1
       WHERE environment_provider_id = 'personal-workspace'`,
    )
    .run();
  await db.$client.exec(
    "DROP INDEX IF EXISTS `environments_provider_instance_idx`",
  );
  await db.$client
    .prepare("ALTER TABLE environments DROP COLUMN environment_provider_id")
    .run();
  await db.$client
    .prepare(
      "ALTER TABLE environments DROP COLUMN environment_provider_selection",
    )
    .run();
  await db.$client
    .prepare(
      "ALTER TABLE environments DROP COLUMN environment_provider_instance_key",
    )
    .run();
  await db.$client.exec(
    "CREATE UNIQUE INDEX environments_project_host_path_idx ON environments (project_id, host_id, path)",
  );
}

async function dropPluginArtifactGitCheckoutRootColumn(
  db: DbConnection,
): Promise<void> {
  const columns = await db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(plugin_artifacts)")
    .all();
  if (columns.some((column) => column.name === "git_checkout_root")) {
    await db.$client
      .prepare("ALTER TABLE plugin_artifacts DROP COLUMN git_checkout_root")
      .run();
  }
}

async function dropEnvironmentRetireRequestedAtColumn(
  db: DbConnection,
): Promise<void> {
  const columns = await db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(environments)")
    .all();
  if (columns.some((column) => column.name === "retire_requested_at")) {
    await db.$client
      .prepare("ALTER TABLE environments DROP COLUMN retire_requested_at")
      .run();
  }
}

async function restoreEnvironmentCleanupModeColumn(
  db: DbConnection,
): Promise<void> {
  await db.$client
    .prepare("ALTER TABLE environments ADD COLUMN cleanup_mode text")
    .run();
}

async function restoreEnvironmentCleanupRequestedAtColumn(
  db: DbConnection,
): Promise<void> {
  const columns = (
    await db.$client
      .prepare<[], TableInfoRow>("PRAGMA table_info(environments)")
      .all()
  ).map((row) => row.name);
  if (!columns.includes("cleanup_requested_at")) {
    await db.$client
      .prepare(
        "ALTER TABLE environments ADD COLUMN cleanup_requested_at integer",
      )
      .run();
  }
  await db.$client
    .prepare(
      "CREATE INDEX IF NOT EXISTS environments_cleanup_requested_idx ON environments (cleanup_requested_at)",
    )
    .run();
}

async function restoreThreadStopRequestedAtColumn(
  db: DbConnection,
): Promise<void> {
  await db.$client
    .prepare("ALTER TABLE threads ADD COLUMN stop_requested_at integer")
    .run();
}

async function dropPost0023Tables(db: DbConnection): Promise<void> {
  await dropEventParentToolCallIdColumn(db);
  await dropQueueReworkSchema(db);
  await dropEnvironmentRetireRequestedAtColumn(db);
  await dropPluginArtifactGitCheckoutRootColumn(db);
  await dropProjectGitRemoteUrlColumn(db);
  await db.$client.prepare("DROP TABLE IF EXISTS thread_tabs").run();
  await db.$client.exec(`
    DROP TRIGGER IF EXISTS thread_search_segments_after_text_update;
    DROP TRIGGER IF EXISTS thread_search_segments_after_delete;
    DROP TRIGGER IF EXISTS thread_search_segments_after_insert;
    DROP TABLE IF EXISTS thread_search_segments_fts;
    DROP TABLE IF EXISTS thread_search_segments;
  `);

  for (const table of [
    "workflow_run_events",
    "workflow_run_operations",
    "workflow_runs",
    "project_workflow_policies",
    "system_experiments",
    "event_large_values",
  ]) {
    await db.$client.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }

  await dropThreadSectionSchema(db);
}

async function dropProjectGitRemoteUrlColumn(db: DbConnection): Promise<void> {
  const columns = await db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(projects)")
    .all();
  if (columns.some((column) => column.name === "git_remote_url")) {
    await db.$client
      .prepare("ALTER TABLE projects DROP COLUMN git_remote_url")
      .run();
  }
}

async function dropThreadSectionSchema(db: DbConnection): Promise<void> {
  await db.$client.exec(
    "DROP INDEX IF EXISTS threads_folder_archived_deleted_idx;",
  );
  await db.$client.exec(
    "DROP INDEX IF EXISTS threads_section_archived_deleted_idx;",
  );
  const threadColumns = await db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(threads)")
    .all();
  if (threadColumns.some((row) => row.name === "section_id")) {
    await db.$client
      .prepare("ALTER TABLE threads DROP COLUMN section_id")
      .run();
  }
  await db.$client.exec("DROP TABLE IF EXISTS thread_sections;");
}

async function restorePre0022ThreadTypeSchema(db: DbConnection): Promise<void> {
  await db.$client.exec(`
    ALTER TABLE project_execution_defaults
      ADD COLUMN thread_type text DEFAULT 'standard' NOT NULL;
    DROP INDEX project_execution_defaults_project_idx;
    CREATE UNIQUE INDEX project_execution_defaults_project_thread_type_idx
      ON project_execution_defaults (project_id, thread_type);
    CREATE INDEX project_execution_defaults_project_idx
      ON project_execution_defaults (project_id);

    ALTER TABLE threads ADD COLUMN type text DEFAULT 'standard' NOT NULL;
    ALTER TABLE threads ADD COLUMN sort_key text;
    CREATE INDEX threads_project_type_sort_idx
      ON threads (project_id, type, sort_key, id);

    -- Drop columns/indexes added by migrations after this restore point so the
    -- forward replay re-applies them without duplicate-column errors.
    DROP INDEX IF EXISTS threads_source_origin_idx;
    ALTER TABLE threads DROP COLUMN source_thread_id;
    ALTER TABLE threads DROP COLUMN origin_kind;
  `);
  const threadColumns = await db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(threads)")
    .all();
  if (threadColumns.some((row) => row.name === "child_origin")) {
    await db.$client
      .prepare("ALTER TABLE threads DROP COLUMN child_origin")
      .run();
  }
}

async function readIndexNames(args: ReadIndexNamesArgs): Promise<string[]> {
  return (
    await args.db.$client
      .prepare<TableNameParameters, IndexNameRow>(
        `
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name = ?
        ORDER BY name
      `,
      )
      .all(args.tableName)
  ).map((row) => row.name);
}

async function readTableNames(db: DbConnection): Promise<string[]> {
  return (
    await db.$client
      .prepare<[], TableNameRow>(
        `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
        ORDER BY name
      `,
      )
      .all()
  ).map((row) => row.name);
}

async function readLatestAppliedMigrationCreatedAt(
  db: DbConnection,
): Promise<number> {
  const row = await db.$client
    .prepare<[], LatestMigrationCreatedAtRow>(
      `
        SELECT MAX(created_at) AS createdAt
        FROM __drizzle_migrations
      `,
    )
    .get();
  const createdAt = row?.createdAt;
  if (typeof createdAt !== "number") {
    throw new Error("Expected at least one applied migration timestamp");
  }
  return createdAt;
}

async function readAppliedMigrationCreatedAts(
  db: DbConnection,
): Promise<number[]> {
  return (
    await db.$client
      .prepare<[], MigrationCreatedAtRow>(
        `
        SELECT created_at AS createdAt
        FROM __drizzle_migrations
        ORDER BY created_at
      `,
      )
      .all()
  ).map((row) => row.createdAt);
}

async function replaceAppliedMigrationHash(
  args: ReplaceAppliedMigrationHashArgs,
): Promise<void> {
  await args.db.$client
    .prepare<DeleteMigrationParameters>(
      `
        DELETE FROM __drizzle_migrations
        WHERE created_at = ?
      `,
    )
    .run(args.createdAt);
  await args.db.$client
    .prepare<InsertMigrationParameters>(
      `
        INSERT INTO __drizzle_migrations (hash, created_at)
        VALUES (?, ?)
      `,
    )
    .run(args.hash, args.createdAt);
}

function runMigrationFile(args: RunMigrationFileArgs): void {
  const migrationSql = readFileSync(args.migrationPath, "utf-8");

  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

  for (const statement of statements) {
    args.db.$client.exec(statement);
  }
}

async function markEventLargeValuesMigrationUnapplied(
  db: DbConnection,
): Promise<void> {
  await db.$client.prepare("DROP TABLE IF EXISTS event_large_values").run();
  await restoreEnvironmentCleanupModeColumn(db);
  await restoreEnvironmentCleanupRequestedAtColumn(db);
  await restoreThreadStopRequestedAtColumn(db);
  await dropThreadSectionSchema(db);
  await db.$client
    .prepare<DeleteMigrationParameters>(
      `
        DELETE FROM __drizzle_migrations
        WHERE created_at >= ?
      `,
    )
    .run(eventLargeValuesMigrationWhen);
  await db.$client
    .prepare("DROP INDEX IF EXISTS `threads_source_origin_idx`")
    .run();
  await db.$client
    .prepare("ALTER TABLE `threads` DROP COLUMN `source_thread_id`")
    .run();
  await db.$client
    .prepare("ALTER TABLE `threads` DROP COLUMN `origin_kind`")
    .run();
  const threadColumns = await db.$client
    .prepare<[], TableInfoRow>("PRAGMA table_info(threads)")
    .all();
  if (threadColumns.some((row) => row.name === "child_origin")) {
    await db.$client
      .prepare("ALTER TABLE threads DROP COLUMN child_origin")
      .run();
  }
  await db.$client.exec(`
    DROP TRIGGER IF EXISTS thread_search_segments_after_text_update;
    DROP TRIGGER IF EXISTS thread_search_segments_after_delete;
    DROP TRIGGER IF EXISTS thread_search_segments_after_insert;
    DROP TABLE IF EXISTS thread_search_segments_fts;
    DROP TABLE IF EXISTS thread_search_segments;
  `);
}

function seedEventLargeValueBackfillThread(db: DbConnection): void {
  db.$client.exec(`
    INSERT INTO projects (id, name, created_at, updated_at)
    VALUES ('proj_large_value_backfill', 'Large Value Backfill', 1000, 1000);

    INSERT INTO threads (
      id,
      project_id,
      provider_id,
      latest_attention_at,
      created_at,
      updated_at
    )
    VALUES (
      'thr_large_value_backfill',
      'proj_large_value_backfill',
      'codex',
      1000,
      1000,
      1000
    );
  `);
}

async function seedEventLargeValueBackfillEvent(
  db: DbConnection,
  args: SeedEventLargeValueBackfillEventArgs,
): Promise<void> {
  await db.$client
    .prepare<[string, number, string, string, string, string, number]>(
      `
        INSERT INTO events (
          id,
          thread_id,
          scope_kind,
          turn_id,
          sequence,
          type,
          item_id,
          item_kind,
          data,
          created_at
        )
        VALUES (
          ?,
          'thr_large_value_backfill',
          'turn',
          'turn_large_value_backfill',
          ?,
          ?,
          ?,
          ?,
          ?,
          ?
        )
      `,
    )
    .run(
      args.id,
      args.sequence,
      args.type ?? "item/completed",
      args.itemId,
      args.itemKind,
      args.data,
      args.createdAt,
    );
}

async function seedEventLargeValueBackfillEvents(
  db: DbConnection,
): Promise<SeededLargeValueBackfillValues> {
  const values: SeededLargeValueBackfillValues = {
    commandOutput: "command output ".repeat(48),
    toolResult: { body: "tool result ".repeat(48) },
    webFetchResult: "web fetch result ".repeat(40),
    webSearchResult: "web search result ".repeat(40),
    firstDiff: "first diff ".repeat(60),
    secondDiff: "second diff ".repeat(60),
  };

  await seedEventLargeValueBackfillEvent(db, {
    id: "evt_large_command_output",
    itemId: "cmd_large",
    itemKind: "commandExecution",
    sequence: 1,
    createdAt: 2001,
    data: JSON.stringify({
      item: {
        id: "cmd_large",
        type: "commandExecution",
        aggregatedOutput: values.commandOutput,
      },
    }),
  });
  await seedEventLargeValueBackfillEvent(db, {
    id: "evt_large_tool_result",
    itemId: "tool_large",
    itemKind: "toolCall",
    sequence: 2,
    createdAt: 2002,
    data: JSON.stringify({
      item: {
        id: "tool_large",
        type: "toolCall",
        result: values.toolResult,
      },
    }),
  });
  await seedEventLargeValueBackfillEvent(db, {
    id: "evt_large_web_fetch",
    itemId: "web_fetch_large",
    itemKind: "webFetch",
    sequence: 3,
    createdAt: 2003,
    data: JSON.stringify({
      item: {
        id: "web_fetch_large",
        type: "webFetch",
        resultText: values.webFetchResult,
      },
    }),
  });
  await seedEventLargeValueBackfillEvent(db, {
    id: "evt_large_web_search",
    itemId: "web_search_large",
    itemKind: "webSearch",
    sequence: 4,
    createdAt: 2004,
    data: JSON.stringify({
      item: {
        id: "web_search_large",
        type: "webSearch",
        resultText: values.webSearchResult,
      },
    }),
  });
  await seedEventLargeValueBackfillEvent(db, {
    id: "evt_large_file_diffs",
    itemId: "file_large",
    itemKind: "fileChange",
    sequence: 5,
    createdAt: 2005,
    data: JSON.stringify({
      item: {
        id: "file_large",
        type: "fileChange",
        changes: [
          { path: "a.ts", diff: values.firstDiff },
          { path: "b.ts", diff: "small diff" },
          { path: "c.ts", diff: values.secondDiff },
        ],
      },
    }),
  });

  return values;
}

async function readMigratedEventData(
  db: DbConnection,
  eventId: string,
): Promise<string> {
  const row = await db.$client
    .prepare<[string], MigratedEventDataRow>(
      `
        SELECT data
        FROM events
        WHERE id = ?
      `,
    )
    .get(eventId);
  if (!row) {
    throw new Error(`Expected migrated event ${eventId}`);
  }
  return row.data;
}

async function expectEventLargeValuesInline(
  db: DbConnection,
  values: SeededLargeValueBackfillValues,
): Promise<void> {
  const commandData = JSON.parse(
    await readMigratedEventData(db, "evt_large_command_output"),
  );
  expect(commandData.item.aggregatedOutput).toBe(values.commandOutput);
  expect(commandData.item.truncation).toBeUndefined();

  const toolData = JSON.parse(
    await readMigratedEventData(db, "evt_large_tool_result"),
  );
  expect(toolData.item.result).toEqual(values.toolResult);
  expect(toolData.item.truncation).toBeUndefined();

  const webFetchData = JSON.parse(
    await readMigratedEventData(db, "evt_large_web_fetch"),
  );
  expect(webFetchData.item.resultText).toBe(values.webFetchResult);
  expect(webFetchData.item.truncation).toBeUndefined();

  const webSearchData = JSON.parse(
    await readMigratedEventData(db, "evt_large_web_search"),
  );
  expect(webSearchData.item.resultText).toBe(values.webSearchResult);
  expect(webSearchData.item.truncation).toBeUndefined();

  const fileData = JSON.parse(
    await readMigratedEventData(db, "evt_large_file_diffs"),
  );
  expect(fileData.item.changes).toEqual([
    { path: "a.ts", diff: values.firstDiff },
    { path: "b.ts", diff: "small diff" },
    { path: "c.ts", diff: values.secondDiff },
  ]);
}

function runQueuedMessageSortKeyMigration(db: DbConnection): void {
  runMigrationFile({ db, migrationPath: queuedMessageSortKeyMigrationPath });
}

function runSidebarOrderingMigration(db: DbConnection): void {
  runMigrationFile({ db, migrationPath: sidebarOrderingMigrationPath });
}

function runThreadPinningMigration(db: DbConnection): void {
  runMigrationFile({ db, migrationPath: threadPinningMigrationPath });
}

async function deleteDeferredCleanupMigrationRows(
  db: DbConnection,
): Promise<void> {
  await db.$client
    .prepare<DeleteMigrationsParameters>(
      `
        DELETE FROM __drizzle_migrations
        WHERE created_at IN (?, ?, ?, ?)
      `,
    )
    .run(
      operationStateBackfillMigrationWhen,
      eventProducerColumnsMigrationWhen,
      terminalSessionRuntimeStateHonestyWhen,
      hostDaemonSessionObservabilityMigrationWhen,
    );
}

describe.skipIf(isPostgresTest)("migrate", () => {
  beforeAll(async () => {
    await prepareMigratedConnectionTemplate();
  });

  it("adds retained outputs without rewriting events", async () => {
    const db = await createMigratedConnection();

    try {
      const host = await upsertHost(db, noopNotifier, {
        id: "host-retained-output-migration",
        name: "Migration Host",
      });
      const { project } = await createProject(db, noopNotifier, {
        name: "Migration Project",
        source: {
          type: "local_path",
          hostId: host.id,
          path: "/tmp/retained-output-migration",
        },
      });
      const thread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      const eventData = JSON.stringify({ message: "existing event" });

      await db.$client.prepare("DROP TABLE provider_model_catalogs").run();
      await db.$client
        .prepare("DROP TABLE IF EXISTS ui_preference_defaults")
        .run();
      await db.$client.prepare("DROP TABLE ui_preferences").run();
      await db.$client.prepare("DROP TABLE retained_event_outputs").run();
      await db.$client
        .prepare<[string, string, string]>(
          `
            INSERT INTO events (
              id, thread_id, scope_kind, sequence, type, data, created_at
            ) VALUES (?, ?, 'thread', 1, 'system/error', ?, 1234)
          `,
        )
        .run("evt-retained-output-migration", thread.id, eventData);

      runMigrationFile({
        db,
        migrationPath: retainedEventOutputsMigrationPath,
      });

      expect(
        await db.$client
          .prepare<[], MigratedEventDataRow>(
            "SELECT data FROM events WHERE id = 'evt-retained-output-migration'",
          )
          .get(),
      ).toEqual({ data: eventData });
      expect(
        await readIndexNames({ db, tableName: "retained_event_outputs" }),
      ).toContain("retained_event_outputs_expiry_idx");
      expect(
        await db.$client
          .prepare<[], ForeignKeyRow>(
            `
              SELECT
                "table" AS parentTable,
                "from" AS childColumn,
                "to" AS parentColumn,
                on_delete AS onDelete
              FROM pragma_foreign_key_list('retained_event_outputs')
            `,
          )
          .get(),
      ).toEqual({
        childColumn: "event_id",
        onDelete: "CASCADE",
        parentColumn: "id",
        parentTable: "events",
      });
    } finally {
      await closeConnection(db);
    }
  });

  it("backfills the first checkout commit component for every artifact shape", async () => {
    const db = await createConnection(":memory:");
    const commit = "d".repeat(40);
    try {
      await db.$client.exec(`
        CREATE TABLE plugin_artifacts (
          id text PRIMARY KEY NOT NULL,
          source_kind text NOT NULL,
          git_resolved_commit text,
          path text NOT NULL
        );
      `);
      const insert = await db.$client.prepare<
        [string, string, string | null, string]
      >(
        "INSERT INTO plugin_artifacts (id, source_kind, git_resolved_commit, path) VALUES (?, ?, ?, ?)",
      );
      await insert.run("root", "git", commit, `/cache/repo/${commit}`);
      await insert.run(
        "nested",
        "git",
        commit,
        `/cache/repo/${commit}/plugins/a`,
      );
      await insert.run(
        "collision",
        "git",
        commit,
        `/cache/repo/${commit}/vendor/${commit}`,
      );
      await insert.run(
        "windows",
        "git",
        commit,
        `C:\\cache\\repo\\${commit}\\plugins\\a`,
      );
      await insert.run("npm", "npm", null, "/cache/npm/package/1.0.0");
      await insert.run("unresolved-git", "git", null, "/cache/git/legacy");

      runMigrationFile({
        db,
        migrationPath: pluginArtifactCheckoutRootMigrationPath,
      });

      expect(
        await db.$client
          .prepare<[], { id: string; root: string | null }>(
            "SELECT id, git_checkout_root AS root FROM plugin_artifacts ORDER BY id",
          )
          .all(),
      ).toEqual([
        { id: "collision", root: `/cache/repo/${commit}` },
        { id: "nested", root: `/cache/repo/${commit}` },
        { id: "npm", root: null },
        { id: "root", root: `/cache/repo/${commit}` },
        { id: "unresolved-git", root: null },
        { id: "windows", root: `C:\\cache\\repo\\${commit}` },
      ]);
    } finally {
      await closeConnection(db);
    }
  });

  it("backfills the retirement clock only for environments already retiring", async () => {
    const db = await createConnection(":memory:");
    try {
      await db.$client.exec(`
        CREATE TABLE environments (
          id text PRIMARY KEY NOT NULL,
          status text NOT NULL,
          updated_at integer NOT NULL
        );
        INSERT INTO environments (id, status, updated_at) VALUES
          ('env_retiring', 'retiring', 1234),
          ('env_ready', 'ready', 2345);
      `);

      runMigrationFile({
        db,
        migrationPath: retireRequestedAtMigrationPath,
      });

      expect(
        await db.$client
          .prepare<[], { id: string; retireRequestedAt: number | null }>(
            `
              SELECT
                id,
                retire_requested_at AS retireRequestedAt
              FROM environments
              ORDER BY id
            `,
          )
          .all(),
      ).toEqual([
        { id: "env_ready", retireRequestedAt: null },
        { id: "env_retiring", retireRequestedAt: 1234 },
      ]);
    } finally {
      await closeConnection(db);
    }
  });

  it("moves experiment columns into key/value rows without losing values", async () => {
    const db = await createConnection(":memory:");

    try {
      await db.$client.exec(`
        CREATE TABLE system_experiments (
          id text PRIMARY KEY NOT NULL,
          claude_code_mock_cli_traffic integer NOT NULL,
          new_onboarding integer DEFAULT false NOT NULL,
          tools_hub integer DEFAULT false NOT NULL,
          updated_at integer NOT NULL
        );
        INSERT INTO system_experiments VALUES ('current', true, false, true, 1234);
      `);

      runMigrationFile({ db, migrationPath: experimentKeyValueMigrationPath });

      expect(
        await db.$client
          .prepare<[], MigratedExperimentRow>(
            `
            SELECT key, value, updated_at AS updatedAt
            FROM system_experiments
            ORDER BY key
          `,
          )
          .all(),
      ).toEqual([
        { key: "claudeCodeMockCliTraffic", updatedAt: 1234, value: 1 },
        { key: "newOnboarding", updatedAt: 1234, value: 0 },
        { key: "toolsHub", updatedAt: 1234, value: 1 },
      ]);
    } finally {
      await closeConnection(db);
    }
  });

  it("moves app settings columns into key/value rows without losing values", async () => {
    const db = await createConnection(":memory:");

    try {
      await db.$client.exec(`
        CREATE TABLE app_settings (
          id text PRIMARY KEY NOT NULL,
          caffeinate integer DEFAULT false NOT NULL,
          show_keyboard_hints integer DEFAULT true NOT NULL,
          steer_active_thread_on_enter integer DEFAULT false NOT NULL,
          show_unhandled_provider_events integer DEFAULT false NOT NULL,
          codex_memory_enabled integer DEFAULT true NOT NULL,
          claude_code_memory_enabled integer DEFAULT true NOT NULL,
          codex_subagents_disabled integer DEFAULT false NOT NULL,
          claude_code_subagents_disabled integer DEFAULT false NOT NULL,
          claude_code_workflows_disabled integer DEFAULT false NOT NULL,
          keybinding_overrides text DEFAULT '[]' NOT NULL,
          onboarding_completed_at text,
          updated_at integer NOT NULL
        );
        INSERT INTO app_settings VALUES (
          'current', true, false, true, true, false, true, true, false, true,
          '[{"command":"thread.new","shortcut":null}]',
          '2026-08-01T00:00:00.000Z',
          1234
        );
      `);

      runMigrationFile({ db, migrationPath: appSettingsKeyValueMigrationPath });

      expect(await getAppSettings(db)).toEqual({
        showKeyboardHints: false,
        showGitChanges: true,
        steerActiveThreadOnEnter: true,
        terminalCopyOnSelect: true,
        confirmThreadArchive: true,
        showDiagnosticEvents: true,
        keepHistoryAfterContextClear: false,
        summarizeShellCommands: true,
        providerOrder: [],
        defaultProviderId: null,
        providerCompletedTurnDisplay: {},
        machineServerUrl: null,
        defaultMachineAccess: null,
        machineGitCredentialsEnabled: true,
        streamerMode: false,
        allowFastServiceTier: true,
        managedBranchPrefix: "hyperfide/",
        idleProviderSessionTimeoutMinutes: 30,
        onboardingCompletedAt: "2026-08-01T00:00:00.000Z",
        earlyAdopter: false,
      });
      expect(
        await db.$client
          .prepare<[], { key: string; value: string }>(
            "SELECT key, value FROM app_settings_values WHERE key LIKE 'codex%' OR key LIKE 'claudeCode%' ORDER BY key",
          )
          .all(),
      ).toEqual([
        { key: "claudeCodeMemoryEnabled", value: "true" },
        { key: "claudeCodeSubagentsDisabled", value: "false" },
        { key: "claudeCodeWorkflowsDisabled", value: "true" },
        { key: "codexMemoryEnabled", value: "false" },
        { key: "codexSubagentsDisabled", value: "true" },
      ]);
      expect(await getAppKeybindingOverrides(db)).toEqual([
        { command: "thread.new", shortcut: null },
      ]);
      expect(
        await db.$client
          .prepare<[], { updatedAt: number }>(
            "SELECT updated_at AS updatedAt FROM app_settings_values WHERE key = 'showKeyboardHints'",
          )
          .get(),
      ).toEqual({ updatedAt: 1234 });
    } finally {
      await closeConnection(db);
    }
  });

  it("carries the provider knobs into plugin settings and retires the shared rows", async () => {
    const db = await createConnection(":memory:");
    try {
      await db.$client.exec(`
        CREATE TABLE app_settings_values (
          key text PRIMARY KEY NOT NULL,
          value text NOT NULL,
          updated_at integer NOT NULL
        );
        CREATE TABLE plugin_settings (
          plugin_id text NOT NULL,
          key text NOT NULL,
          value text NOT NULL,
          updated_at integer NOT NULL,
          PRIMARY KEY (plugin_id, key)
        );
        INSERT INTO app_settings_values (key, value, updated_at) VALUES
          ('showKeyboardHints', 'false', 10),
          ('codexMemoryEnabled', 'false', 11),
          ('codexSubagentsDisabled', 'true', 12),
          ('claudeCodeMemoryEnabled', 'true', 13),
          ('claudeCodeSubagentsDisabled', 'false', 14),
          ('claudeCodeWorkflowsDisabled', 'true', 15);
        -- A plugin row written before the migration wins over the old value.
        INSERT INTO plugin_settings (plugin_id, key, value, updated_at) VALUES
          ('provider-claude-code', 'memoryEnabled', 'false', 99);
      `);

      runMigrationFile({
        db,
        migrationPath: providerSettingsToPluginsMigrationPath,
      });

      expect(
        await db.$client
          .prepare<
            [],
            { pluginId: string; key: string; value: string; updatedAt: number }
          >(
            "SELECT plugin_id AS pluginId, key, value, updated_at AS updatedAt FROM plugin_settings ORDER BY plugin_id, key",
          )
          .all(),
      ).toEqual([
        {
          pluginId: "provider-claude-code",
          key: "memoryEnabled",
          value: "false",
          updatedAt: 99,
        },
        {
          pluginId: "provider-claude-code",
          key: "subagentsDisabled",
          value: "false",
          updatedAt: 14,
        },
        {
          pluginId: "provider-claude-code",
          key: "workflowsDisabled",
          value: "true",
          updatedAt: 15,
        },
        {
          pluginId: "provider-codex",
          key: "memoryEnabled",
          value: "false",
          updatedAt: 11,
        },
        {
          pluginId: "provider-codex",
          key: "subagentsDisabled",
          value: "true",
          updatedAt: 12,
        },
      ]);
      expect(
        await db.$client
          .prepare<[], { key: string }>(
            "SELECT key FROM app_settings_values ORDER BY key",
          )
          .all(),
      ).toEqual([{ key: "showKeyboardHints" }]);
    } finally {
      await closeConnection(db);
    }
  });

  it("keeps a never-onboarded install null through the app settings move", async () => {
    const db = await createConnection(":memory:");

    try {
      await db.$client.exec(`
        CREATE TABLE app_settings (
          id text PRIMARY KEY NOT NULL,
          caffeinate integer DEFAULT false NOT NULL,
          show_keyboard_hints integer DEFAULT true NOT NULL,
          steer_active_thread_on_enter integer DEFAULT false NOT NULL,
          show_unhandled_provider_events integer DEFAULT false NOT NULL,
          codex_memory_enabled integer DEFAULT true NOT NULL,
          claude_code_memory_enabled integer DEFAULT true NOT NULL,
          codex_subagents_disabled integer DEFAULT false NOT NULL,
          claude_code_subagents_disabled integer DEFAULT false NOT NULL,
          claude_code_workflows_disabled integer DEFAULT false NOT NULL,
          keybinding_overrides text DEFAULT '[]' NOT NULL,
          onboarding_completed_at text,
          updated_at integer NOT NULL
        );
        INSERT INTO app_settings (id, updated_at) VALUES ('current', 1234);
      `);

      runMigrationFile({ db, migrationPath: appSettingsKeyValueMigrationPath });

      expect(await getAppSettings(db)).toEqual({
        ...defaultAppSettings,
        steerActiveThreadOnEnter: false,
      });
      expect(await getAppKeybindingOverrides(db)).toEqual([]);
    } finally {
      await closeConnection(db);
    }
  });

  it("leaves app settings unset when there is no legacy row", async () => {
    const db = await createConnection(":memory:");

    try {
      await db.$client.exec(`
        CREATE TABLE app_settings (
          id text PRIMARY KEY NOT NULL,
          caffeinate integer DEFAULT false NOT NULL,
          show_keyboard_hints integer DEFAULT true NOT NULL,
          steer_active_thread_on_enter integer DEFAULT false NOT NULL,
          show_unhandled_provider_events integer DEFAULT false NOT NULL,
          codex_memory_enabled integer DEFAULT true NOT NULL,
          claude_code_memory_enabled integer DEFAULT true NOT NULL,
          codex_subagents_disabled integer DEFAULT false NOT NULL,
          claude_code_subagents_disabled integer DEFAULT false NOT NULL,
          claude_code_workflows_disabled integer DEFAULT false NOT NULL,
          keybinding_overrides text DEFAULT '[]' NOT NULL,
          onboarding_completed_at text,
          updated_at integer NOT NULL
        );
      `);

      runMigrationFile({ db, migrationPath: appSettingsKeyValueMigrationPath });

      expect(
        await db.$client
          .prepare<[], { count: number }>(
            "SELECT COUNT(*) AS count FROM app_settings_values",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(await getAppSettings(db)).toEqual(defaultAppSettings);
    } finally {
      await closeConnection(db);
    }
  });

  it("keeps queue-on-enter for a store that predates the steer default", async () => {
    const db = await createConnection(":memory:");

    try {
      await db.$client.exec(`
        CREATE TABLE app_settings_values (
          key text PRIMARY KEY NOT NULL,
          value text NOT NULL,
          updated_at integer NOT NULL
        );
        CREATE TABLE projects (id text PRIMARY KEY NOT NULL, kind text NOT NULL);
        CREATE TABLE threads (id text PRIMARY KEY NOT NULL);
        INSERT INTO projects (id, kind) VALUES ('proj_personal', 'personal');
        INSERT INTO projects (id, kind) VALUES ('project-1', 'standard');
      `);

      runMigrationFile({ db, migrationPath: steerOnEnterDefaultMigrationPath });

      expect((await getAppSettings(db)).steerActiveThreadOnEnter).toBe(false);
    } finally {
      await closeConnection(db);
    }
  });

  it("keeps queue-on-enter for a store whose only work is a personal thread", async () => {
    const db = await createConnection(":memory:");

    try {
      await db.$client.exec(`
        CREATE TABLE app_settings_values (
          key text PRIMARY KEY NOT NULL,
          value text NOT NULL,
          updated_at integer NOT NULL
        );
        CREATE TABLE projects (id text PRIMARY KEY NOT NULL, kind text NOT NULL);
        CREATE TABLE threads (id text PRIMARY KEY NOT NULL);
        INSERT INTO projects (id, kind) VALUES ('proj_personal', 'personal');
        INSERT INTO threads (id) VALUES ('thread-1');
      `);

      runMigrationFile({ db, migrationPath: steerOnEnterDefaultMigrationPath });

      expect((await getAppSettings(db)).steerActiveThreadOnEnter).toBe(false);
    } finally {
      await closeConnection(db);
    }
  });

  it("steers on enter for a store that only holds the seeded personal project", async () => {
    const db = await createConnection(":memory:");

    try {
      await db.$client.exec(`
        CREATE TABLE app_settings_values (
          key text PRIMARY KEY NOT NULL,
          value text NOT NULL,
          updated_at integer NOT NULL
        );
        CREATE TABLE projects (id text PRIMARY KEY NOT NULL, kind text NOT NULL);
        CREATE TABLE threads (id text PRIMARY KEY NOT NULL);
        INSERT INTO projects (id, kind) VALUES ('proj_personal', 'personal');
      `);

      runMigrationFile({ db, migrationPath: steerOnEnterDefaultMigrationPath });

      expect(
        await db.$client
          .prepare<[], { count: number }>(
            "SELECT COUNT(*) AS count FROM app_settings_values",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect((await getAppSettings(db)).steerActiveThreadOnEnter).toBe(true);
    } finally {
      await closeConnection(db);
    }
  });

  it("steers on enter for a store built by a full migration run", async () => {
    const db = await createConnection(":memory:");

    try {
      await migrate(db);

      expect((await getAppSettings(db)).steerActiveThreadOnEnter).toBe(true);
    } finally {
      await closeConnection(db);
    }
  });

  it("keeps a chosen steer preference through the steer default change", async () => {
    const db = await createConnection(":memory:");

    try {
      await db.$client.exec(`
        CREATE TABLE app_settings_values (
          key text PRIMARY KEY NOT NULL,
          value text NOT NULL,
          updated_at integer NOT NULL
        );
        CREATE TABLE projects (id text PRIMARY KEY NOT NULL, kind text NOT NULL);
        CREATE TABLE threads (id text PRIMARY KEY NOT NULL);
        INSERT INTO projects (id, kind) VALUES ('project-1', 'standard');
        INSERT INTO app_settings_values (key, value, updated_at)
        VALUES ('steerActiveThreadOnEnter', 'true', 1234);
      `);

      runMigrationFile({ db, migrationPath: steerOnEnterDefaultMigrationPath });

      expect(
        await db.$client
          .prepare<[], { value: string; updatedAt: number }>(
            "SELECT value, updated_at AS updatedAt FROM app_settings_values WHERE key = 'steerActiveThreadOnEnter'",
          )
          .get(),
      ).toEqual({ value: "true", updatedAt: 1234 });
      expect((await getAppSettings(db)).steerActiveThreadOnEnter).toBe(true);
    } finally {
      await closeConnection(db);
    }
  });

  const ONBOARDING_STAMP_FIXTURE = `
    CREATE TABLE app_settings_values (
      key text PRIMARY KEY NOT NULL,
      value text NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE TABLE projects (id text PRIMARY KEY NOT NULL, kind text NOT NULL);
    CREATE TABLE threads (id text PRIMARY KEY NOT NULL);
    INSERT INTO projects (id, kind) VALUES ('proj_personal', 'personal');
  `;

  it.each([
    {
      name: "a store with a real project",
      seed: "INSERT INTO projects (id, kind) VALUES ('project-1', 'standard');",
    },
    {
      name: "a store whose only work is a personal thread",
      seed: "INSERT INTO threads (id) VALUES ('thread-1');",
    },
    {
      name: "a store whose earlier setup guide never finished",
      seed: `
        INSERT INTO projects (id, kind) VALUES ('project-1', 'standard');
        INSERT INTO app_settings_values (key, value, updated_at)
        VALUES ('onboardingCompletedAt', 'null', 1234);
      `,
    },
  ])("marks $name as already set up", async ({ seed }) => {
    const db = await createConnection(":memory:");

    try {
      await db.$client.exec(ONBOARDING_STAMP_FIXTURE);
      await db.$client.exec(seed);

      runMigrationFile({ db, migrationPath: stampOnboardingMigrationPath });

      const completedAt = (await getAppSettings(db)).onboardingCompletedAt;
      expect(completedAt).not.toBeNull();
      expect(Number.isNaN(Date.parse(completedAt ?? ""))).toBe(false);
    } finally {
      await closeConnection(db);
    }
  });

  it("leaves the setup guide pending for a store that only holds the seeded personal project", async () => {
    const db = await createConnection(":memory:");

    try {
      await db.$client.exec(ONBOARDING_STAMP_FIXTURE);

      runMigrationFile({ db, migrationPath: stampOnboardingMigrationPath });

      expect(
        await db.$client
          .prepare<[], { count: number }>(
            "SELECT count(*) AS count FROM app_settings_values WHERE key = 'onboardingCompletedAt'",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect((await getAppSettings(db)).onboardingCompletedAt).toBeNull();
    } finally {
      await closeConnection(db);
    }
  });

  it("keeps the time an earlier setup guide was finished", async () => {
    const db = await createConnection(":memory:");

    try {
      await db.$client.exec(ONBOARDING_STAMP_FIXTURE);
      await db.$client.exec(`
        INSERT INTO projects (id, kind) VALUES ('project-1', 'standard');
        INSERT INTO app_settings_values (key, value, updated_at)
        VALUES ('onboardingCompletedAt', '"2026-08-01T00:00:00.000Z"', 1234);
      `);

      runMigrationFile({ db, migrationPath: stampOnboardingMigrationPath });

      expect((await getAppSettings(db)).onboardingCompletedAt).toBe(
        "2026-08-01T00:00:00.000Z",
      );
    } finally {
      await closeConnection(db);
    }
  });

  it("adopts legacy side chats as the side-chat plugin's hidden forks", async () => {
    const db = await createConnection(":memory:");

    try {
      await migrate(db);
      const host = await upsertHost(db, noopNotifier, {
        name: "side-chat-adoption-host",
      });
      const { project } = await createProject(db, noopNotifier, {
        name: "side-chat-adoption-project",
        source: {
          type: "local_path",
          hostId: host.id,
          path: "/tmp/side-chat-adoption",
        },
      });
      const source = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      const sideChat = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        originKind: "fork",
        sourceThreadId: source.id,
      });
      const orphanSideChat = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      const pluginFork = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        originKind: "fork",
        originPluginId: "workflows",
        sourceThreadId: source.id,
      });
      await db.$client
        .prepare(
          "UPDATE threads SET origin_kind = 'side-chat' WHERE id IN (?, ?)",
        )
        .run(sideChat.id, orphanSideChat.id);

      await db.$client.exec(
        "DROP INDEX IF EXISTS `threads_origin_plugin_archived_idx`",
      );
      await restoreSideChatPluginExperimentColumn(db);
      await restoreLegacyThreadOriginColumn(db);
      runMigrationFile({ db, migrationPath: sideChatPluginOnlyMigrationPath });

      const rows = await db.$client
        .prepare<[], MigratedThreadOriginRow>(
          "SELECT id, origin_kind AS originKind, origin_plugin_id AS originPluginId, visibility FROM threads",
        )
        .all();
      const byId = new Map(rows.map((row) => [row.id, row]));

      expect(byId.get(sideChat.id)).toMatchObject({
        originKind: "fork",
        originPluginId: "side-chat",
        visibility: "hidden",
      });
      expect(byId.get(orphanSideChat.id)).toMatchObject({
        originKind: null,
        originPluginId: null,
        visibility: "visible",
      });
      expect(byId.get(pluginFork.id)).toMatchObject({
        originKind: "fork",
        originPluginId: "workflows",
      });
      expect(rows.filter((row) => row.originKind === "side-chat")).toHaveLength(
        0,
      );
    } finally {
      await closeConnection(db);
    }
  });

  it("migrates mutable permission state while preserving side-chat source intent", async () => {
    const db = await createConnection(":memory:");

    try {
      await migrate(db);
      const host = await upsertHost(db, noopNotifier, {
        name: "permission-migration-host",
      });
      const { project } = await createProject(db, noopNotifier, {
        name: "permission-migration-project",
        source: {
          type: "local_path",
          hostId: host.id,
          path: "/tmp/permission-migration-project",
        },
      });
      const sourceWithHistory = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        status: "idle",
      });
      const sourceWithoutHistory = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        status: "idle",
      });
      const sideChatWithHistory = await createThread(db, noopNotifier, {
        originKind: "fork",
        projectId: project.id,
        providerId: "codex",
        sourceThreadId: sourceWithHistory.id,
        status: "idle",
      });
      const sideChatWithoutHistory = await createThread(db, noopNotifier, {
        originKind: "fork",
        projectId: project.id,
        providerId: "codex",
        sourceThreadId: sourceWithoutHistory.id,
        status: "idle",
      });
      await db.$client
        .prepare(
          "UPDATE threads SET origin_kind = 'side-chat' WHERE id IN (?, ?)",
        )
        .run(sideChatWithHistory.id, sideChatWithoutHistory.id);
      const regularThread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        status: "idle",
      });
      const workspaceWriteQueue = await createQueuedThreadMessage(
        db,
        noopNotifier,
        {
          threadId: regularThread.id,
          content: [
            { type: "text", text: "legacy workspace write", mentions: [] },
          ],
          model: "gpt-5",
          permissionMode: "full",
          reasoningLevel: "medium",
          serviceTier: "default",
          waitingOn: null,
          sendAt: null,
          payload: { kind: "inline" },
          systemNotice: null,
        },
      );
      const inheritedQueue = await createQueuedThreadMessage(db, noopNotifier, {
        threadId: sideChatWithHistory.id,
        content: [{ type: "text", text: "legacy side chat", mentions: [] }],
        model: "gpt-5",
        permissionMode: "full",
        reasoningLevel: "medium",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      });
      const fallbackQueue = await createQueuedThreadMessage(db, noopNotifier, {
        threadId: sideChatWithoutHistory.id,
        content: [{ type: "text", text: "legacy fallback", mentions: [] }],
        model: "gpt-5",
        permissionMode: "full",
        reasoningLevel: "medium",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      });
      await db.$client
        .prepare(
          `
            INSERT INTO events (
              id,
              thread_id,
              scope_kind,
              sequence,
              type,
              data,
              created_at
            ) VALUES (?, ?, 'thread', 1, 'client/turn/requested', ?, ?)
          `,
        )
        .run(
          "evt_permission_source_full",
          sourceWithHistory.id,
          JSON.stringify({ execution: { permissionMode: "full" } }),
          Date.now(),
        );
      await db.$client
        .prepare(
          `
            INSERT INTO project_execution_defaults (
              project_id,
              provider_id,
              model,
              service_tier,
              reasoning_level,
              permission_mode,
              updated_at
            ) VALUES (?, 'codex', 'gpt-5', 'default', 'medium', 'readonly', ?)
          `,
        )
        .run(project.id, Date.now());
      await db.$client
        .prepare(
          `
            UPDATE queued_thread_messages
            SET permission_mode = CASE id
              WHEN ? THEN 'workspace-write'
              ELSE 'readonly'
            END
            WHERE id IN (?, ?, ?)
          `,
        )
        .run(
          workspaceWriteQueue.id,
          workspaceWriteQueue.id,
          inheritedQueue.id,
          fallbackQueue.id,
        );
      await restoreWideExperimentsTable(db);
      await db.$client
        .prepare<DeleteMigrationParameters>(
          "DELETE FROM __drizzle_migrations WHERE created_at >= ?",
        )
        .run(permissionModesMigrationWhen);
      await rewindEnvironmentRowFactsMigration(db);
      await rewindEnvironmentProvidersMigration(db);
      await dropSideChatPluginExperimentColumn(db);
      await dropToolsHubExperimentColumn(db);
      await restorePluginsExperimentColumn(db);
      await dropSteerActiveThreadOnEnterColumn(db);
      await dropOnboardingCompletedAtColumn(db);
      await dropAppSettingsValuesTable(db);
      await dropNewOnboardingExperimentColumn(db);
      await dropHostMaxPermissionModeColumn(db);
      await dropEnvironmentRetireRequestedAtColumn(db);
      await dropPluginArtifactGitCheckoutRootColumn(db);
      await dropMarketplaceCatalogSchema(db);
      await dropEventParentToolCallIdColumn(db);
      await dropQueueReworkSchema(db);

      await restoreLegacyThreadOriginColumn(db);
      await migrate(db);

      expect(
        await db.$client
          .prepare<[string], { permissionMode: string }>(
            `
              SELECT permission_mode AS permissionMode
              FROM project_execution_defaults
              WHERE project_id = ?
            `,
          )
          .get(project.id),
      ).toEqual({ permissionMode: "accept-edits" });
      expect(
        await db.$client
          .prepare<[string, string, string], MigratedPermissionModeRow>(
            `
              SELECT id, permission_mode AS permissionMode
              FROM queued_thread_messages
              WHERE id IN (?, ?, ?)
              ORDER BY id
            `,
          )
          .all(workspaceWriteQueue.id, inheritedQueue.id, fallbackQueue.id),
      ).toEqual(
        [
          { id: workspaceWriteQueue.id, permissionMode: "accept-edits" },
          { id: inheritedQueue.id, permissionMode: "full" },
          { id: fallbackQueue.id, permissionMode: "accept-edits" },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );
    } finally {
      await closeConnection(db);
    }
  });

  it("provisions the singleton personal project", async () => {
    const db = await createConnection(":memory:");

    try {
      await migrate(db);

      const personalProject = await db.$client
        .prepare<[], PersonalProjectMigrationRow>(
          `
            SELECT COUNT(*) AS count
            FROM projects
            WHERE id = 'proj_personal'
              AND kind = 'personal'
              AND name = 'Personal'
          `,
        )
        .get();
      expect(personalProject?.count).toBe(1);

      await expect(
        (async () =>
          await db.$client
            .prepare(
              `
              INSERT INTO projects (id, kind, name, sort_key, created_at, updated_at)
              VALUES ('proj_second_personal', 'personal', 'Second personal', 'V', 1, 1)
            `,
            )
            .run())(),
      ).rejects.toThrow();
    } finally {
      await closeConnection(db);
    }
  });

  it.skipIf(isPostgresTest)(
    "applies rowid thread search rebuild after the compatible thread search hash",
    async () => {
      const db = await createConnection(":memory:");

      try {
        await migrate(db);
        await replaceAppliedMigrationHash({
          db,
          createdAt: threadSearchMigrationWhen,
          hash: rowidThreadSearchMigrationHash,
        });
        await db.$client
          .prepare<DeleteMigrationParameters>(
            "DELETE FROM __drizzle_migrations WHERE created_at = ?",
          )
          .run(threadSearchRowidFtsMigrationWhen);
        await resetMigrationsAfterThreadSearch(db);

        await expect((async () => await migrate(db))()).resolves.not.toThrow();

        expect(
          (
            await db.$client
              .prepare<[], TableInfoRow>(
                "PRAGMA table_info(thread_search_segments_fts)",
              )
              .all()
          ).map((row) => row.name),
        ).toEqual(["text"]);
        expect(
          await db.$client
            .prepare<[number], MigrationCountRow>(
              `
              SELECT COUNT(*) AS count
              FROM __drizzle_migrations
              WHERE created_at = ?
            `,
            )
            .get(threadSearchRowidFtsMigrationWhen),
        ).toEqual({ count: 1 });
      } finally {
        await closeConnection(db);
      }
    },
  );

  it.skipIf(isPostgresTest)(
    "renames thread section storage without losing assignments",
    async () => {
      const db = await createConnection(":memory:");

      try {
        await migrate(db);
        await restoreWideExperimentsTable(db);
        await db.$client.exec(`
        INSERT INTO projects (id, name, created_at, updated_at)
        VALUES ('proj_section_migration', 'Section migration', 1000, 1000);

        INSERT INTO thread_sections (id, name, created_at, updated_at)
        VALUES ('sec_preserved', 'Release QA', 1000, 1000);

        INSERT INTO threads (
          id,
          project_id,
          provider_id,
          section_id,
          latest_attention_at,
          created_at,
          updated_at
        )
        VALUES (
          'thr_section_migration',
          'proj_section_migration',
          'codex',
          'sec_preserved',
          1000,
          1000,
          1000
        );

        DROP INDEX threads_section_archived_deleted_idx;
        DROP INDEX thread_sections_name_idx;
        ALTER TABLE thread_sections RENAME TO thread_folders;
        CREATE UNIQUE INDEX thread_folders_name_idx
          ON thread_folders (name);
        ALTER TABLE threads RENAME COLUMN section_id TO folder_id;
        CREATE INDEX threads_folder_archived_deleted_idx
          ON threads (folder_id, archived_at, deleted_at, id);
        ALTER TABLE system_experiments
          ADD COLUMN thread_splits integer DEFAULT false NOT NULL;
      `);
        await db.$client
          .prepare<DeleteMigrationParameters>(
            "DELETE FROM __drizzle_migrations WHERE created_at >= ?",
          )
          .run(threadSectionsRepairMigrationWhen);
        await rewindEnvironmentRowFactsMigration(db);
        await rewindEnvironmentProvidersMigration(db);
        await dropSideChatPluginExperimentColumn(db);
        await dropToolsHubExperimentColumn(db);
        await restorePluginsExperimentColumn(db);
        await dropSteerActiveThreadOnEnterColumn(db);
        await dropOnboardingCompletedAtColumn(db);
        await dropAppSettingsValuesTable(db);
        await dropNewOnboardingExperimentColumn(db);
        await dropHostMaxPermissionModeColumn(db);
        await dropEnvironmentRetireRequestedAtColumn(db);
        await dropPluginArtifactGitCheckoutRootColumn(db);
        await dropMarketplaceCatalogSchema(db);
        await dropEventParentToolCallIdColumn(db);
        await dropQueueReworkSchema(db);

        await restoreLegacyThreadOriginColumn(db);
        await expect((async () => await migrate(db))()).resolves.not.toThrow();

        expect(await readTableNames(db)).toContain("thread_sections");
        expect(await readTableNames(db)).not.toContain("thread_folders");
        expect(
          await db.$client
            .prepare<[], { sectionId: string | null }>(
              `
              SELECT section_id AS sectionId
              FROM threads
              WHERE id = 'thr_section_migration'
            `,
            )
            .get(),
        ).toEqual({ sectionId: "sec_preserved" });
        expect(await readIndexNames({ db, tableName: "threads" })).toContain(
          "threads_section_archived_deleted_idx",
        );
        expect(
          await db.$client.prepare("PRAGMA foreign_key_check").all(),
        ).toEqual([]);
      } finally {
        await closeConnection(db);
      }
    },
  );

  it.skipIf(isPostgresTest)(
    "removes manager thread type schema while preserving existing threads",
    async () => {
      const db = await createConnection(":memory:");

      try {
        await migrate(db);
        await dropRewindAddedTables(db);
        await restorePre0022ThreadTypeSchema(db);
        await db.$client.exec(`
        INSERT INTO projects (id, name, created_at, updated_at)
        VALUES ('proj_manager_cleanup', 'Manager cleanup', 1000, 1000);

        INSERT INTO threads (
          id,
          project_id,
          provider_id,
          type,
          sort_key,
          title,
          status,
          latest_attention_at,
          created_at,
          updated_at
        )
        VALUES (
          'thr_former_manager',
          'proj_manager_cleanup',
          'codex',
          'manager',
          '0000000000000001',
          'Former manager',
          'idle',
          2000,
          2000,
          2000
        );

        INSERT INTO threads (
          id,
          project_id,
          provider_id,
          type,
          parent_thread_id,
          title,
          status,
          latest_attention_at,
          created_at,
          updated_at
        )
        VALUES (
          'thr_former_child',
          'proj_manager_cleanup',
          'codex',
          'standard',
          'thr_former_manager',
          'Former child',
          'idle',
          3000,
          3000,
          3000
        );

        INSERT INTO project_execution_defaults (
          project_id,
          provider_id,
          thread_type,
          model,
          service_tier,
          reasoning_level,
          permission_mode,
          updated_at
        )
        VALUES
          (
            'proj_manager_cleanup',
            'codex',
            'standard',
            'gpt-5',
            'default',
            'medium',
            'full',
            4000
          ),
          (
            'proj_manager_cleanup',
            'codex',
            'manager',
            'gpt-5.5',
            'default',
            'xhigh',
            'full',
            5000
          );

      `);
        await db.$client
          .prepare<DeleteMigrationParameters>(
            `
            DELETE FROM __drizzle_migrations
            WHERE created_at >= ?
          `,
          )
          .run(threadTypeRemovalMigrationWhen);
        await dropPost0023Tables(db);
        await restoreEnvironmentCleanupModeColumn(db);
        await restoreEnvironmentCleanupRequestedAtColumn(db);
        await restoreThreadStopRequestedAtColumn(db);

        await migrate(db);

        const threadColumns = (
          await db.$client
            .prepare<[], TableInfoRow>("PRAGMA table_info(threads)")
            .all()
        ).map((row) => row.name);
        expect(threadColumns).not.toContain("type");
        expect(threadColumns).not.toContain("sort_key");

        const defaultsColumns = (
          await db.$client
            .prepare<[], TableInfoRow>(
              "PRAGMA table_info(project_execution_defaults)",
            )
            .all()
        ).map((row) => row.name);
        expect(defaultsColumns).not.toContain("thread_type");

        expect(
          await db.$client
            .prepare<[], MigratedManagerCleanupThreadRow>(
              `
              SELECT id, parent_thread_id AS parentThreadId
              FROM threads
              WHERE id IN ('thr_former_manager', 'thr_former_child')
              ORDER BY id
            `,
            )
            .all(),
        ).toEqual([
          {
            id: "thr_former_child",
            parentThreadId: "thr_former_manager",
          },
          {
            id: "thr_former_manager",
            parentThreadId: null,
          },
        ]);

        expect(
          await db.$client
            .prepare<[], MigratedManagerCleanupDefaultRow>(
              `
              SELECT
                provider_id AS providerId,
                model,
                service_tier AS serviceTier,
                reasoning_level AS reasoningLevel,
                permission_mode AS permissionMode
              FROM project_execution_defaults
              WHERE project_id = 'proj_manager_cleanup'
            `,
            )
            .get(),
        ).toEqual({
          providerId: "codex",
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
        });
      } finally {
        await closeConnection(db);
      }
    },
  );

  it.skipIf(isPostgresTest)(
    "moves fork and side-chat provenance out of parent_thread_id",
    async () => {
      const db = await createConnection(":memory:");

      try {
        await migrate(db);
        await db.$client
          .prepare("DROP INDEX IF EXISTS `threads_source_origin_idx`")
          .run();
        await db.$client
          .prepare("ALTER TABLE `threads` DROP COLUMN `source_thread_id`")
          .run();
        await db.$client
          .prepare("ALTER TABLE `threads` DROP COLUMN `origin_kind`")
          .run();
        await restoreLegacyThreadOriginColumn(db);
        await db.$client
          .prepare<DeleteMigrationParameters>(
            `
            DELETE FROM __drizzle_migrations
            WHERE created_at >= ?
          `,
          )
          .run(threadSourceOriginMigrationWhen);
        await dropRewindAddedTables(db);
        await db.$client.exec(`
        DROP TRIGGER IF EXISTS thread_search_segments_after_text_update;
        DROP TRIGGER IF EXISTS thread_search_segments_after_delete;
        DROP TRIGGER IF EXISTS thread_search_segments_after_insert;
        DROP TABLE IF EXISTS thread_search_segments_fts;
        DROP TABLE IF EXISTS thread_search_segments;
      `);

        await db.$client.exec(`
        INSERT INTO projects (id, kind, name, sort_key, created_at, updated_at)
        VALUES ('proj_thread_provenance', 'standard', 'Thread provenance', 'a', 1000, 1000);

        INSERT INTO threads (
          id,
          project_id,
          provider_id,
          title,
          status,
          latest_attention_at,
          created_at,
          updated_at
        )
        VALUES (
          'thr_source',
          'proj_thread_provenance',
          'codex',
          'Source',
          'idle',
          1000,
          1000,
          1000
        );

        INSERT INTO threads (
          id,
          project_id,
          provider_id,
          parent_thread_id,
          child_origin,
          title,
          status,
          latest_attention_at,
          created_at,
          updated_at
        )
        VALUES
          (
            'thr_delegated_child',
            'proj_thread_provenance',
            'codex',
            'thr_source',
            NULL,
            'Delegated child',
            'idle',
            1100,
            1100,
            1100
          ),
          (
            'thr_fork',
            'proj_thread_provenance',
            'codex',
            'thr_source',
            'fork',
            'Fork',
            'idle',
            1200,
            1200,
            1200
          ),
          (
            'thr_side_chat',
            'proj_thread_provenance',
            'codex',
            'thr_source',
            'side-chat',
            'Side chat',
            'idle',
            1300,
            1300,
            1300
          );
      `);

        await migrate(db);

        expect(
          await db.$client
            .prepare<[], MigratedThreadProvenanceRow>(
              `
              SELECT
                id,
                parent_thread_id AS parentThreadId,
                source_thread_id AS sourceThreadId,
                origin_kind AS originKind
              FROM threads
              WHERE id IN ('thr_delegated_child', 'thr_fork', 'thr_side_chat')
              ORDER BY id
            `,
            )
            .all(),
        ).toEqual([
          {
            id: "thr_delegated_child",
            parentThreadId: "thr_source",
            sourceThreadId: null,
            originKind: null,
          },
          {
            id: "thr_fork",
            parentThreadId: null,
            sourceThreadId: "thr_source",
            originKind: "fork",
          },
          {
            id: "thr_side_chat",
            parentThreadId: null,
            sourceThreadId: "thr_source",
            originKind: "fork",
          },
        ]);
        expect(
          (
            await db.$client
              .prepare<[], TableInfoRow>("PRAGMA table_info(threads)")
              .all()
          ).some((column) => column.name === "child_origin"),
        ).toBe(false);
      } finally {
        await closeConnection(db);
      }
    },
  );

  it.skipIf(isPostgresTest)(
    "repairs history for cleanup migrations already reflected in schema",
    async () => {
      const db = await createConnection(":memory:");

      try {
        await migrate(db);
        await db.$client.exec(`
        ALTER TABLE environments
          ADD COLUMN cleanup_mode text DEFAULT 'defer' NOT NULL;
        ALTER TABLE environments
          ADD COLUMN cleanup_requested_at integer;
        CREATE INDEX environments_cleanup_requested_idx
          ON environments (cleanup_requested_at);
        ALTER TABLE threads
          ADD COLUMN stop_requested_at integer;
      `);
        await db.$client
          .prepare<[number, number, number]>(
            `
            DELETE FROM __drizzle_migrations
            WHERE created_at IN (?, ?, ?)
          `,
          )
          .run(
            cleanupModeDropMigrationWhen,
            stopRequestedAtDropMigrationWhen,
            cleanupRequestedAtDropMigrationWhen,
          );

        await migrate(db);

        const environmentColumns = (
          await db.$client
            .prepare<[], TableInfoRow>("PRAGMA table_info(environments)")
            .all()
        ).map((row) => row.name);
        expect(environmentColumns).not.toContain("cleanup_mode");
        expect(environmentColumns).not.toContain("cleanup_requested_at");

        const threadColumns = (
          await db.$client
            .prepare<[], TableInfoRow>("PRAGMA table_info(threads)")
            .all()
        ).map((row) => row.name);
        expect(threadColumns).not.toContain("stop_requested_at");

        const appliedCreatedAts = (
          await db.$client
            .prepare<[number, number, number], MigrationCreatedAtRow>(
              `
            SELECT created_at AS createdAt
            FROM __drizzle_migrations
            WHERE created_at IN (?, ?, ?)
            ORDER BY created_at
          `,
            )
            .all(
              cleanupModeDropMigrationWhen,
              stopRequestedAtDropMigrationWhen,
              cleanupRequestedAtDropMigrationWhen,
            )
        ).map((row) => row.createdAt);
        expect(appliedCreatedAts).toEqual([
          cleanupModeDropMigrationWhen,
          stopRequestedAtDropMigrationWhen,
          cleanupRequestedAtDropMigrationWhen,
        ]);
      } finally {
        await closeConnection(db);
      }
    },
  );

  it.skipIf(isPostgresTest)(
    "normalizes legacy expired pending interactions and drops session_id",
    async () => {
      const db = await createConnection(":memory:");

      try {
        await db.$client.exec(`
        CREATE TABLE pending_interactions (
          id text PRIMARY KEY NOT NULL,
          thread_id text NOT NULL,
          turn_id text NOT NULL,
          provider_id text NOT NULL,
          provider_thread_id text NOT NULL,
          provider_request_id text NOT NULL,
          session_id text NOT NULL,
          status text NOT NULL,
          payload text NOT NULL,
          resolution text,
          status_reason text,
          created_at integer NOT NULL,
          resolved_at integer,
          updated_at integer NOT NULL
        );
        INSERT INTO pending_interactions (
          id,
          thread_id,
          turn_id,
          provider_id,
          provider_thread_id,
          provider_request_id,
          session_id,
          status,
          payload,
          resolution,
          status_reason,
          created_at,
          resolved_at,
          updated_at
        )
        VALUES
          (
            'pi_expired_without_reason',
            'thr_legacy_pending',
            'turn_legacy_pending_1',
            'codex',
            'provider-thread-legacy-pending',
            'request-legacy-pending-1',
            'session-legacy-pending',
            'expired',
            '{}',
            NULL,
            NULL,
            10,
            NULL,
            20
          ),
          (
            'pi_expired_with_reason',
            'thr_legacy_pending',
            'turn_legacy_pending_2',
            'codex',
            'provider-thread-legacy-pending',
            'request-legacy-pending-2',
            'session-legacy-pending',
            'expired',
            '{}',
            NULL,
            'Already expired',
            30,
            50,
            40
          ),
          (
            'pi_interrupted',
            'thr_legacy_pending',
            'turn_legacy_pending_3',
            'codex',
            'provider-thread-legacy-pending',
            'request-legacy-pending-3',
            'session-legacy-pending',
            'interrupted',
            '{}',
            NULL,
            'Manual stop',
            60,
            70,
            80
          );
        CREATE TABLE events (
          id text PRIMARY KEY NOT NULL,
          type text NOT NULL,
          data text NOT NULL
        );
        INSERT INTO events (id, type, data)
        VALUES
          (
            'evt_expired_permission_grant',
            'system/permissionGrant/lifecycle',
            '{"status":"expired","statusReason":"Already expired"}'
          ),
          (
            'evt_expired_user_question',
            'system/userQuestion/lifecycle',
            '{"status":"expired"}'
          ),
          (
            'evt_interrupted_permission_grant',
            'system/permissionGrant/lifecycle',
            '{"status":"interrupted","statusReason":"Manual stop"}'
          ),
          (
            'evt_other_expired',
            'system/operation',
            '{"status":"expired"}'
          );
      `);

        runMigrationFile({
          db,
          migrationPath: pendingInteractionSchemaHonestyMigrationPath,
        });

        const rows = await db.$client
          .prepare<[], MigratedPendingInteractionStatusRow>(
            `
            SELECT
              id,
              status,
              status_reason AS statusReason,
              resolved_at AS resolvedAt,
              updated_at AS updatedAt
            FROM pending_interactions
            ORDER BY id
          `,
          )
          .all();

        expect(rows).toEqual([
          {
            id: "pi_expired_with_reason",
            status: "interrupted",
            statusReason: "Already expired",
            resolvedAt: 50,
            updatedAt: 50,
          },
          {
            id: "pi_expired_without_reason",
            status: "interrupted",
            statusReason: "Pending interaction expired",
            resolvedAt: 20,
            updatedAt: 20,
          },
          {
            id: "pi_interrupted",
            status: "interrupted",
            statusReason: "Manual stop",
            resolvedAt: 70,
            updatedAt: 80,
          },
        ]);
        const pendingInteractionColumns = (
          await db.$client
            .prepare<[], TableNameRow>(
              `
            SELECT name
            FROM pragma_table_info('pending_interactions')
            ORDER BY cid
          `,
            )
            .all()
        ).map((row) => row.name);
        expect(pendingInteractionColumns).toEqual([
          "id",
          "thread_id",
          "turn_id",
          "provider_id",
          "provider_thread_id",
          "provider_request_id",
          "status",
          "payload",
          "resolution",
          "status_reason",
          "created_at",
          "resolved_at",
          "updated_at",
        ]);
        const eventRows = await db.$client
          .prepare<[], MigratedPendingInteractionEventStatusRow>(
            `
            SELECT
              id,
              json_extract(data, '$.status') AS status,
              json_extract(data, '$.statusReason') AS statusReason
            FROM events
            ORDER BY id
          `,
          )
          .all();
        expect(eventRows).toEqual([
          {
            id: "evt_expired_permission_grant",
            status: "interrupted",
            statusReason: "Already expired",
          },
          {
            id: "evt_expired_user_question",
            status: "interrupted",
            statusReason: "Pending interaction expired",
          },
          {
            id: "evt_interrupted_permission_grant",
            status: "interrupted",
            statusReason: "Manual stop",
          },
          {
            id: "evt_other_expired",
            status: "expired",
            statusReason: null,
          },
        ]);
      } finally {
        await closeConnection(db);
      }
    },
  );

  it("warns when applied migration timestamps are in the future", async () => {
    const db = await createConnection(":memory:");
    const logger = {
      warn: vi.fn(),
    } satisfies MigrationWarningLogger;

    try {
      await migrate(db);
      const latestMigrationCreatedAt =
        await readLatestAppliedMigrationCreatedAt(db);
      vi.useFakeTimers();
      vi.setSystemTime(latestMigrationCreatedAt + 10_000);

      await migrate(db, { logger });
      expect(logger.warn).not.toHaveBeenCalled();

      const futureCreatedAt = Date.now() + 60_000;
      await db.$client
        .prepare<InsertMigrationParameters>(
          `
            INSERT INTO __drizzle_migrations (hash, created_at)
            VALUES (?, ?)
          `,
        )
        .run("future-migration-hash", futureCreatedAt);

      await migrate(db, { logger });

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        {
          migrations: [
            {
              createdAt: futureCreatedAt,
              hash: "future-migration-hash",
            },
          ],
          now: expect.any(Number),
        },
        "Applied database migrations have future timestamps",
      );
    } finally {
      await closeConnection(db);
      vi.useRealTimers();
    }
  });

  it.skipIf(isPostgresTest)(
    "defers destructive legacy cleanup while preserving state backfills",
    async () => {
      const db = await createConnection(":memory:");

      try {
        await migrate(db);
        dropIdleLifecycleIndexes(db);
        await rewindThreadPruningWork(db);
        await dropQueuedMessageEditHeldUntilColumn(db);
        await dropMarketplaceSourceGitSubdirectoryColumn(db);
        await dropThreadParentNotificationsColumn(db);
        await db.$client.prepare("DROP INDEX projects_deleted_idx").run();
        await db.$client
          .prepare("ALTER TABLE projects DROP COLUMN deleted_at")
          .run();
        await db.$client
          .prepare("ALTER TABLE events ADD producer_event_id text")
          .run();
        await db.$client
          .prepare("ALTER TABLE events ADD producer_event_payload_hash text")
          .run();
        await db.$client
          .prepare(
            "CREATE UNIQUE INDEX events_producer_event_id_idx ON events (producer_event_id)",
          )
          .run();
        await db.$client
          .prepare(
            "ALTER TABLE hosts ADD command_cursor integer DEFAULT 0 NOT NULL",
          )
          .run();
        await db.$client.exec(`
        CREATE TABLE host_daemon_commands (
          id text PRIMARY KEY NOT NULL
        );
        CREATE TABLE host_daemon_command_attempts (
          id text PRIMARY KEY NOT NULL
        );
        CREATE TABLE client_turn_requests (
          id text PRIMARY KEY NOT NULL
        );
        CREATE TABLE environment_operations (
          id text PRIMARY KEY NOT NULL,
          environment_id text NOT NULL,
          kind text NOT NULL,
          state text NOT NULL
        );
        CREATE TABLE project_operations (
          id text PRIMARY KEY NOT NULL,
          project_id text NOT NULL,
          kind text NOT NULL,
          state text NOT NULL,
          requested_at integer NOT NULL
        );
        CREATE TABLE thread_operations (
          id text PRIMARY KEY NOT NULL,
          thread_id text NOT NULL,
          kind text NOT NULL,
          state text NOT NULL,
          payload text NOT NULL,
          requested_at integer NOT NULL
        );
        INSERT INTO hosts (
          id,
          name,
          type,
          command_cursor,
          created_at,
          updated_at
        )
        VALUES (
          'host_deferred_cleanup',
          'Deferred cleanup host',
          'persistent',
          0,
          1000,
          1000
        );
        INSERT INTO projects (
          id,
          name,
          created_at,
          updated_at
        )
        VALUES (
          'proj_deferred_cleanup',
          'Deferred cleanup project',
          1000,
          1000
        );
        INSERT INTO environments (
          id,
          project_id,
          host_id,
          path,
          status,
          created_at,
          updated_at
        )
        VALUES (
          'env_deferred_cleanup',
          'proj_deferred_cleanup',
          'host_deferred_cleanup',
          '/tmp/deferred-cleanup',
          'provisioning',
          1000,
          1000
        );
        INSERT INTO threads (
          id,
          project_id,
          environment_id,
          provider_id,
          status,
          latest_attention_at,
          created_at,
          updated_at
        )
        VALUES (
          'thr_deferred_cleanup',
          'proj_deferred_cleanup',
          'env_deferred_cleanup',
          'codex',
          'provisioning',
          1000,
          1000,
          1000
        ),
        (
          'thr_deferred_bad_stop_reason',
          'proj_deferred_cleanup',
          'env_deferred_cleanup',
          'codex',
          'active',
          1000,
          1000,
          1000
        );
        INSERT INTO thread_operations (
          id,
          thread_id,
          kind,
          state,
          payload,
          requested_at
        )
        VALUES
          (
            'top_deferred_provision',
            'thr_deferred_cleanup',
            'provision',
            'queued',
            '{}',
            2000
          ),
          (
            'top_deferred_stop',
            'thr_deferred_cleanup',
            'stop',
            'requested',
            '{"interruptionReason":"host-daemon-restarted"}',
            2500
          ),
          (
            'top_deferred_bad_stop_reason',
            'thr_deferred_bad_stop_reason',
            'stop',
            'queued',
            '{"interruptionReason":"legacy-freeform-reason"}',
            2550
          );
        INSERT INTO environment_operations (
          id,
          environment_id,
          kind,
          state
        )
        VALUES (
          'eop_deferred_provision',
          'env_deferred_cleanup',
          'provision',
          'queued'
        );
        INSERT INTO project_operations (
          id,
          project_id,
          kind,
          state,
          requested_at
        )
        VALUES (
          'pop_deferred_delete',
          'proj_deferred_cleanup',
          'delete',
          'requested',
          3000
        );
      `);
        await deleteDeferredCleanupMigrationRows(db);
        await restoreEnvironmentCleanupRequestedAtColumn(db);
        await restoreThreadStopRequestedAtColumn(db);

        await migrate(db);

        expect(await readTableNames(db)).toEqual(
          expect.arrayContaining([
            "client_turn_requests",
            "environment_operations",
            "host_daemon_command_attempts",
            "host_daemon_commands",
            "project_operations",
            "thread_operations",
          ]),
        );
        expect(
          (
            await db.$client
              .prepare<[], TableInfoRow>("PRAGMA table_info(events)")
              .all()
          ).map((row) => row.name),
        ).toEqual(expect.arrayContaining(["producer_event_id"]));
        expect(
          (
            await db.$client
              .prepare<[], TableInfoRow>("PRAGMA table_info(hosts)")
              .all()
          ).map((row) => row.name),
        ).toEqual(expect.arrayContaining(["command_cursor"]));
        expect(
          await db.$client
            .prepare<[], OperationBackfillThreadRow>(
              `
              SELECT status
              FROM threads
              WHERE id = 'thr_deferred_cleanup'
            `,
            )
            .get(),
        ).toEqual({
          status: "error",
        });
        expect(
          await db.$client
            .prepare<[], OperationBackfillProjectRow>(
              `
              SELECT deleted_at AS deletedAt
              FROM projects
              WHERE id = 'proj_deferred_cleanup'
            `,
            )
            .get(),
        ).toEqual({
          deletedAt: 3_000,
        });
        expect(
          await db.$client
            .prepare<[], OperationBackfillEnvironmentRow>(
              `
              SELECT status
              FROM environments
              WHERE id = 'env_deferred_cleanup'
            `,
            )
            .get(),
        ).toEqual({
          status: "error",
        });
        expect(
          await db.$client
            .prepare<[], MigratedEventRow>(
              `
              SELECT
                id,
                thread_id AS threadId,
                environment_id AS environmentId,
                scope_kind AS scopeKind,
                turn_id AS turnId,
                provider_thread_id AS providerThreadId,
                sequence,
                type,
                item_id AS itemId,
                item_kind AS itemKind,
                data,
                created_at AS createdAt
              FROM events
              WHERE id = 'evt_top_deferred_stop'
            `,
            )
            .get(),
        ).toEqual({
          createdAt: 2_500,
          data: '{"reason":"host-daemon-restarted"}',
          environmentId: "env_deferred_cleanup",
          id: "evt_top_deferred_stop",
          itemId: null,
          itemKind: null,
          providerThreadId: null,
          scopeKind: "thread",
          sequence: 1,
          threadId: "thr_deferred_cleanup",
          turnId: null,
          type: "system/thread/interrupted",
        });
        expect(
          await db.$client
            .prepare<[], Pick<MigratedEventRow, "data">>(
              `
              SELECT data
              FROM events
              WHERE id = 'evt_top_deferred_bad_stop_reason'
            `,
            )
            .get(),
        ).toEqual({
          data: '{"reason":"manual-stop"}',
        });

        const migrationCreatedAts = (
          await db.$client
            .prepare<[], MigrationCreatedAtRow>(
              `
            SELECT created_at AS createdAt
            FROM __drizzle_migrations
            ORDER BY created_at
          `,
            )
            .all()
        ).map((row) => row.createdAt);
        expect(migrationCreatedAts).toEqual(
          expect.arrayContaining([
            operationStateBackfillMigrationWhen,
            eventProducerColumnsMigrationWhen,
            terminalSessionRuntimeStateHonestyWhen,
            hostDaemonSessionObservabilityMigrationWhen,
          ]),
        );
      } finally {
        await closeConnection(db);
      }
    },
  );

  it("skips legacy large event value round trip when values are already inline", async () => {
    const db = await createMigratedConnection();

    try {
      await dropRewindAddedTables(db);
      seedEventLargeValueBackfillThread(db);
      const values = await seedEventLargeValueBackfillEvents(db);

      await markEventLargeValuesMigrationUnapplied(db);
      await db.$client
        .prepare<DeleteMigrationParameters>(
          `
            DELETE FROM __drizzle_migrations
            WHERE created_at = ?
          `,
        )
        .run(legacyExperimentsMigrationWhen);

      await migrate(db);

      expect(await readLatestAppliedMigrationCreatedAt(db)).toBe(
        latestMigrationWhen,
      );
      expect(await readTableNames(db)).not.toContain("event_large_values");
      expect(
        await db.$client
          .prepare<[number], MigrationCountRow>(
            `
              SELECT COUNT(*) AS count
              FROM __drizzle_migrations
              WHERE created_at = ?
            `,
          )
          .get(eventLargeValuesMigrationWhen),
      ).toEqual({ count: 1 });
      expect(
        await db.$client
          .prepare<[number], MigrationCountRow>(
            `
              SELECT COUNT(*) AS count
              FROM __drizzle_migrations
              WHERE created_at = ?
            `,
          )
          .get(eventLargeValuesRestoreMigrationWhen),
      ).toEqual({ count: 1 });

      await expectEventLargeValuesInline(db, values);
    } finally {
      await closeConnection(db);
    }
  });

  it("restores legacy large event values to inline payloads", async () => {
    const db = await createMigratedConnection();

    try {
      await dropRewindAddedTables(db);
      seedEventLargeValueBackfillThread(db);
      const values = await seedEventLargeValueBackfillEvents(db);

      await markEventLargeValuesMigrationUnapplied(db);
      runMigrationFile({ db, migrationPath: eventLargeValuesMigrationPath });
      await replaceAppliedMigrationHash({
        db,
        createdAt: eventLargeValuesMigrationWhen,
        hash: eventLargeValuesPreOptimizationHash,
      });

      await migrate(db);

      expect(await readAppliedMigrationCreatedAts(db)).toContain(
        eventLargeValuesRestoreMigrationWhen,
      );
      expect(await readLatestAppliedMigrationCreatedAt(db)).toBe(
        latestMigrationWhen,
      );
      expect(await readTableNames(db)).not.toContain("event_large_values");
      await expectEventLargeValuesInline(db, values);
    } finally {
      await closeConnection(db);
    }
  });

  it("throws when an applied migration hash is missing behind the latest timestamp", async () => {
    const db = await createConnection(":memory:");

    try {
      await migrate(db);
      await db.$client
        .prepare<DeleteMigrationParameters>(
          `
            DELETE FROM __drizzle_migrations
            WHERE created_at = ?
          `,
        )
        .run(threadPinningMigrationWhen);

      await expect((async () => await migrate(db))()).rejects.toThrow(
        /Missing applied migration timestamps: 0008_thread_pinning/,
      );
    } finally {
      await closeConnection(db);
    }
  });

  it("accepts a published migration row with a released timestamp and historical hash", async () => {
    const db = await createConnection(":memory:");

    try {
      await migrate(db);
      await replaceAppliedMigrationHash({
        db,
        createdAt: closedSessionPruneIndexesWhen,
        hash: "published-0002-historical-hash",
      });

      await expect((async () => await migrate(db))()).resolves.not.toThrow();
    } finally {
      await closeConnection(db);
    }
  });

  it("accepts the pre-optimization event large values migration hash", async () => {
    const db = await createConnection(":memory:");

    try {
      await migrate(db);
      await replaceAppliedMigrationHash({
        db,
        createdAt: eventLargeValuesMigrationWhen,
        hash: eventLargeValuesPreOptimizationHash,
      });

      await expect((async () => await migrate(db))()).resolves.not.toThrow();
    } finally {
      await closeConnection(db);
    }
  });

  it("accepts the event parent migration hash from before its JSON guard", async () => {
    const db = await createConnection(":memory:");

    try {
      await migrate(db);
      await db.$client
        .prepare(
          "UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?",
        )
        .run(
          eventParentToolCallPreJsonValidMigrationHash,
          eventParentToolCallMigrationWhen,
        );

      await expect((async () => await migrate(db))()).resolves.not.toThrow();
    } finally {
      await closeConnection(db);
    }
  });

  it("fails clearly before provider-request uniqueness migration when pending interaction duplicates exist", async () => {
    const db = await createConnection(":memory:");

    try {
      await db.$client.exec(`
        CREATE TABLE pending_interactions (
          provider_id text,
          provider_thread_id text,
          provider_request_id text,
          session_id text NOT NULL
        );
        INSERT INTO pending_interactions (
          provider_id,
          provider_thread_id,
          provider_request_id,
          session_id
        )
        VALUES
          ('codex', 'provider-thread-1', 'request-1', 'session-1'),
          ('codex', 'provider-thread-1', 'request-1', 'session-2'),
          (NULL, NULL, NULL, 'plugin-session-1'),
          (NULL, NULL, NULL, 'plugin-session-2');
      `);

      await expect((async () => await migrate(db))()).rejects.toThrow(
        /Duplicates: codex\/provider-thread-1\/request-1 count=2\./,
      );
    } finally {
      await closeConnection(db);
    }
  });

  it("rejects a non-published migration row with a matching timestamp and wrong hash", async () => {
    const db = await createConnection(":memory:");

    try {
      await migrate(db);
      await replaceAppliedMigrationHash({
        db,
        createdAt: threadPinningMigrationWhen,
        hash: "non-published-0008-wrong-hash",
      });

      await expect((async () => await migrate(db))()).rejects.toThrow(
        /Mismatched applied migration hashes: 0008_thread_pinning/,
      );
    } finally {
      await closeConnection(db);
    }
  });

  it("backfills queued message sort keys in existing created order", async () => {
    const db = await createConnection(":memory:");

    try {
      await db.$client.exec(`
        CREATE TABLE threads (
          id text PRIMARY KEY NOT NULL
        );
        CREATE TABLE queued_thread_messages (
          id text PRIMARY KEY NOT NULL,
          thread_id text NOT NULL,
          content text NOT NULL,
          model text NOT NULL,
          reasoning_level text NOT NULL,
          permission_mode text NOT NULL,
          service_tier text NOT NULL,
          claimed_at integer,
          claim_token text,
          created_at integer NOT NULL,
          updated_at integer NOT NULL,
          FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE cascade
        );
      `);
      await db.$client
        .prepare("INSERT INTO threads (id) VALUES (?), (?)")
        .run("thr_a", "thr_b");
      const insertQueuedMessage =
        await db.$client.prepare<QueuedMessageMigrationInsertParameters>(
          `
          INSERT INTO queued_thread_messages (
            id,
            thread_id,
            content,
            model,
            reasoning_level,
            permission_mode,
            service_tier,
            created_at,
            updated_at
          )
          VALUES (?, ?, '[]', 'gpt-5', 'medium', 'full', 'default', ?, ?)
        `,
        );
      await insertQueuedMessage.run("qmsg_b", "thr_a", 1_000, 1_000);
      await insertQueuedMessage.run("qmsg_a", "thr_a", 1_000, 1_000);
      await insertQueuedMessage.run("qmsg_c", "thr_a", 2_000, 2_000);
      await insertQueuedMessage.run("qmsg_other", "thr_b", 500, 500);

      runQueuedMessageSortKeyMigration(db);

      expect(
        await db.$client
          .prepare<[], MigratedQueuedMessageRow>(
            `
              SELECT id, thread_id AS threadId, sort_key AS sortKey
              FROM queued_thread_messages
              ORDER BY thread_id, sort_key
            `,
          )
          .all(),
      ).toEqual([
        { id: "qmsg_a", threadId: "thr_a", sortKey: "0000000000000001" },
        { id: "qmsg_b", threadId: "thr_a", sortKey: "0000000000000002" },
        { id: "qmsg_c", threadId: "thr_a", sortKey: "0000000000000003" },
        {
          id: "qmsg_other",
          threadId: "thr_b",
          sortKey: "0000000000000001",
        },
      ]);
    } finally {
      await closeConnection(db);
    }
  });

  it("backfills project and manager thread sort keys", async () => {
    const db = await createConnection(":memory:");

    try {
      await db.$client.exec(`
        CREATE TABLE projects (
          id text PRIMARY KEY NOT NULL,
          name text NOT NULL,
          created_at integer NOT NULL,
          updated_at integer NOT NULL
        );
        CREATE TABLE threads (
          id text PRIMARY KEY NOT NULL,
          project_id text NOT NULL,
          type text NOT NULL,
          created_at integer NOT NULL
        );
      `);
      const insertProject =
        await db.$client.prepare<ProjectSortKeyMigrationInsertParameters>(
          `
            INSERT INTO projects (id, name, created_at, updated_at)
            VALUES (?, ?, ?, ?)
          `,
        );
      await insertProject.run("proj_b", "Project B", 1_000, 1_000);
      await insertProject.run("proj_a", "Project A", 1_000, 1_000);
      await insertProject.run("proj_c", "Project C", 2_000, 2_000);

      const insertThread =
        await db.$client.prepare<ThreadSortKeyMigrationInsertParameters>(
          `
            INSERT INTO threads (id, project_id, type, created_at)
            VALUES (?, ?, ?, ?)
          `,
        );
      await insertThread.run("thr_manager_b", "proj_a", "manager", 1_000);
      await insertThread.run("thr_manager_a", "proj_a", "manager", 2_000);
      await insertThread.run("thr_standard", "proj_a", "standard", 3_000);
      await insertThread.run("thr_other", "proj_b", "manager", 500);

      runSidebarOrderingMigration(db);

      expect(
        await db.$client
          .prepare<[], MigratedProjectRow>(
            `
              SELECT id, sort_key AS sortKey
              FROM projects
              ORDER BY sort_key
            `,
          )
          .all(),
      ).toEqual([
        { id: "proj_a", sortKey: "0000000000000001" },
        { id: "proj_b", sortKey: "0000000000000002" },
        { id: "proj_c", sortKey: "0000000000000003" },
      ]);
      expect(
        await db.$client
          .prepare<[], MigratedThreadSortKeyRow>(
            `
              SELECT id, sort_key AS sortKey
              FROM threads
              WHERE project_id = 'proj_a'
              ORDER BY sort_key
            `,
          )
          .all(),
      ).toEqual([
        { id: "thr_standard", sortKey: null },
        { id: "thr_manager_a", sortKey: "0000000000000001" },
        { id: "thr_manager_b", sortKey: "0000000000000002" },
      ]);
    } finally {
      await closeConnection(db);
    }
  });

  it.skipIf(isPostgresTest)(
    "adds nullable thread pinning columns and index",
    async () => {
      const db = await createConnection(":memory:");

      try {
        await db.$client.exec(`
        CREATE TABLE threads (
          id text PRIMARY KEY NOT NULL,
          project_id text NOT NULL,
          archived_at integer,
          deleted_at integer
        );
      `);

        runThreadPinningMigration(db);

        const columns = await db.$client
          .prepare<[], TableInfoRow>("PRAGMA table_info(threads)")
          .all();
        const columnsByName = new Map(
          columns.map((column) => [column.name, column]),
        );
        expect(columnsByName.get("pinned_at")?.notnull).toBe(0);
        expect(columnsByName.get("pin_sort_key")?.notnull).toBe(0);
        expect(await readIndexNames({ db, tableName: "threads" })).toContain(
          "threads_pin_sort_idx",
        );
      } finally {
        await closeConnection(db);
      }
    },
  );

  it("migrates official marketplace provenance to the singleton catalog without changing direct source data", async () => {
    const db = await createConnection(":memory:");
    try {
      await db.$client.exec(`
        CREATE TABLE plugins (
          id text PRIMARY KEY NOT NULL,
          provenance text NOT NULL,
          marketplace_id text,
          marketplace_entry_id text,
          source text NOT NULL
        );
        CREATE TABLE marketplaces (
          id text PRIMARY KEY NOT NULL,
          source_kind text NOT NULL,
          location text NOT NULL,
          requested_git_ref text,
          catalog_json text,
          last_successful_refresh_at integer,
          last_attempted_refresh_at integer,
          last_error text,
          created_at integer NOT NULL,
          updated_at integer NOT NULL
        );
        INSERT INTO marketplaces VALUES
          ('hyperfide-official', 'git', 'https://github.com/ymichael/hyperfide.git', 'main', '{"schemaVersion":1,"name":"hyperfide-official","displayName":"HYPERFIDE Official","plugins":[]}', 10, 20, NULL, 1, 20),
          ('other', 'git', 'https://example.test/catalog.git', 'main', '{"schemaVersion":1}', 30, 40, NULL, 2, 40);
        INSERT INTO plugins VALUES
          ('official', 'marketplace', 'hyperfide-official', 'notes', 'npm:notes@^1'),
          ('third-party', 'marketplace', 'other', 'tasks', 'git:https://example.test/tasks@main'),
          ('already-direct', 'direct', NULL, NULL, 'path:/tmp/plugin');
      `);

      runMigrationFile({ db, migrationPath: pluginCatalogMigrationPath });

      expect(
        await db.$client
          .prepare<[], MigratedPluginCatalogProvenanceRow>(
            `
            SELECT id, provenance, catalog_entry_id AS catalogEntryId
            FROM plugins ORDER BY id
          `,
          )
          .all(),
      ).toEqual([
        {
          id: "already-direct",
          provenance: "direct",
          catalogEntryId: null,
        },
        { id: "official", provenance: "catalog", catalogEntryId: "notes" },
        {
          id: "third-party",
          provenance: "direct",
          catalogEntryId: null,
        },
      ]);
      expect(
        await db.$client
          .prepare<[], MigratedPluginCatalogRow>(
            `
            SELECT catalog_json AS catalogJson,
              last_attempted_refresh_at AS lastAttemptedRefreshAt
            FROM plugin_catalog
          `,
          )
          .get(),
      ).toEqual({
        catalogJson: '{"schemaVersion":1,"plugins":[]}',
        lastAttemptedRefreshAt: 20,
      });
      expect(await readTableNames(db)).not.toContain("marketplaces");
      expect(
        await db.$client
          .prepare<[], { source: string }>(
            "SELECT source FROM plugins WHERE id = 'third-party'",
          )
          .get(),
      ).toEqual({ source: "git:https://example.test/tasks@main" });
    } finally {
      await closeConnection(db);
    }
  });

  it("does not grant catalog provenance to a custom marketplace named hyperfide-official", async () => {
    const db = await createConnection(":memory:");
    try {
      await db.$client.exec(`
        CREATE TABLE plugins (
          id text PRIMARY KEY NOT NULL,
          provenance text NOT NULL,
          marketplace_id text,
          marketplace_entry_id text,
          source text NOT NULL
        );
        CREATE TABLE marketplaces (
          id text PRIMARY KEY NOT NULL,
          source_kind text NOT NULL,
          location text NOT NULL,
          requested_git_ref text,
          catalog_json text,
          last_successful_refresh_at integer,
          last_attempted_refresh_at integer,
          last_error text,
          created_at integer NOT NULL,
          updated_at integer NOT NULL
        );
        INSERT INTO marketplaces VALUES (
          'hyperfide-official',
          'git',
          'https://example.test/custom.git',
          'main',
          '{"schemaVersion":1}',
          10,
          20,
          NULL,
          1,
          20
        );
        INSERT INTO plugins VALUES (
          'custom',
          'marketplace',
          'hyperfide-official',
          'custom-entry',
          'npm:hyperfide-plugin-custom@^1'
        );
      `);

      runMigrationFile({ db, migrationPath: pluginCatalogMigrationPath });

      expect(
        await db.$client
          .prepare<[], MigratedPluginCatalogProvenanceRow>(
            `
            SELECT id, provenance, catalog_entry_id AS catalogEntryId
            FROM plugins
          `,
          )
          .get(),
      ).toEqual({
        id: "custom",
        provenance: "direct",
        catalogEntryId: null,
      });
      expect(
        await db.$client
          .prepare<[], MigrationCountRow>(
            "SELECT COUNT(*) AS count FROM plugin_catalog",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      await closeConnection(db);
    }
  });

  it("moves the curated marketplace, its icons, and its installs together", async () => {
    const db = await createConnection(":memory:");
    try {
      await db.$client.exec(`
        CREATE TABLE plugin_marketplaces (
          name text PRIMARY KEY NOT NULL,
          etag text,
          last_modified text
        );
        CREATE TABLE plugin_marketplace_icons (
          marketplace_name text NOT NULL,
          entry_id text NOT NULL,
          PRIMARY KEY (marketplace_name, entry_id)
        );
        CREATE TABLE plugins (
          id text PRIMARY KEY NOT NULL,
          catalog_marketplace_name text
        );
        INSERT INTO plugin_marketplaces VALUES
          ('hyperfide-official', 'W/\"abc\"', 'Wed, 01 Jan 2025 00:00:00 GMT'),
          ('acme', 'W/\"xyz\"', 'Thu, 02 Jan 2025 00:00:00 GMT');
        INSERT INTO plugin_marketplace_icons VALUES
          ('hyperfide-official', 'notes'),
          ('acme', 'tasks');
        INSERT INTO plugins VALUES
          ('notes', 'hyperfide-official'),
          ('tasks', 'acme'),
          ('local', NULL);
      `);

      runMigrationFile({
        db,
        migrationPath: curatedMarketplaceRenameMigrationPath,
      });

      expect(
        await db.$client
          .prepare<[], { name: string }>(
            "SELECT name FROM plugin_marketplaces ORDER BY name",
          )
          .all(),
      ).toEqual([{ name: "acme" }, { name: "hyperfide-community" }]);
      expect(
        await db.$client
          .prepare<[], { marketplaceName: string }>(
            "SELECT marketplace_name AS marketplaceName FROM plugin_marketplace_icons ORDER BY marketplace_name",
          )
          .all(),
      ).toEqual([
        { marketplaceName: "acme" },
        { marketplaceName: "hyperfide-community" },
      ]);
      expect(
        await db.$client
          .prepare<[], { id: string; catalogMarketplaceName: string | null }>(
            "SELECT id, catalog_marketplace_name AS catalogMarketplaceName FROM plugins ORDER BY id",
          )
          .all(),
      ).toEqual([
        { id: "local", catalogMarketplaceName: null },
        { id: "notes", catalogMarketplaceName: "hyperfide-community" },
        { id: "tasks", catalogMarketplaceName: "acme" },
      ]);

      expect(
        await db.$client
          .prepare<
            [],
            { name: string; etag: string | null; lastModified: string | null }
          >(
            "SELECT name, etag, last_modified AS lastModified FROM plugin_marketplaces ORDER BY name",
          )
          .all(),
      ).toEqual([
        {
          name: "acme",
          etag: 'W/"xyz"',
          lastModified: "Thu, 02 Jan 2025 00:00:00 GMT",
        },
        { name: "hyperfide-community", etag: null, lastModified: null },
      ]);
    } finally {
      await closeConnection(db);
    }
  });

  it("moves the bundled provider usage plugin and its footer preferences to the hyperfide-- id", async () => {
    const db = await createConnection(":memory:");
    try {
      await migrate(db);
      await db.$client.exec(`
        INSERT INTO plugins (id, source, root_dir, version, enabled, installed_at, updated_at, provenance, source_kind, source_builtin_name, removed_at)
        VALUES
          ('provider-usage', 'builtin:provider-usage', '/bundled/provider-usage', '0.1.0', 0, 1, 1, 'builtin', 'builtin', 'provider-usage', 7),
          ('usage', 'git:https://example.com/usage.git', '/managed/usage', '0.3.1', 1, 1, 1, 'catalog', 'git', NULL, NULL);
        INSERT INTO ui_preferences (key, value_json, revision, updated_at) VALUES
          ('sidebar.footerOrder', '["builtin:settings","plugin:provider-usage/usage","plugin:usage/usage"]', 3, 1),
          ('sidebar.hiddenFooterItems', '["plugin:provider-usage/usage"]', 5, 1),
          ('sidebar.visiblePluginPanels', '["provider-usage/usage"]', 2, 1);
      `);

      runMigrationFile({
        db,
        migrationPath: providerUsagePluginIdMigrationPath,
      });

      expect(
        await db.$client
          .prepare<
            [],
            { id: string; enabled: number; removedAt: number | null }
          >(
            "SELECT id, enabled, removed_at AS removedAt FROM plugins ORDER BY id",
          )
          .all(),
      ).toEqual([
        { id: "hyperfide--provider-usage", enabled: 0, removedAt: 7 },
        { id: "usage", enabled: 1, removedAt: null },
      ]);
      expect(
        await db.$client
          .prepare<[], { key: string; valueJson: string; revision: number }>(
            "SELECT key, value_json AS valueJson, revision FROM ui_preferences ORDER BY key",
          )
          .all(),
      ).toEqual([
        {
          key: "sidebar.footerOrder",
          valueJson:
            '["builtin:settings","plugin:hyperfide--provider-usage/usage","plugin:usage/usage"]',
          revision: 4,
        },
        {
          key: "sidebar.hiddenFooterItems",
          valueJson: '["plugin:hyperfide--provider-usage/usage"]',
          revision: 6,
        },
        {
          key: "sidebar.visiblePluginPanels",
          valueJson: '["provider-usage/usage"]',
          revision: 2,
        },
      ]);
    } finally {
      await closeConnection(db);
    }
  });

  it("leaves a user-installed provider-usage plugin under its own id", async () => {
    const db = await createConnection(":memory:");
    try {
      await migrate(db);
      await db.$client.exec(`
        INSERT INTO plugins (id, source, root_dir, version, enabled, installed_at, updated_at, provenance, source_kind)
        VALUES ('provider-usage', 'git:https://github.com/braedonsaunders/hyperfide-plugin-provider-usage.git', '/managed/provider-usage', '0.4.0', 1, 1, 1, 'catalog', 'git');
      `);

      runMigrationFile({
        db,
        migrationPath: providerUsagePluginIdMigrationPath,
      });

      expect(await db.$client.prepare("SELECT id FROM plugins").all()).toEqual([
        { id: "provider-usage" },
      ]);
    } finally {
      await closeConnection(db);
    }
  });

  it("names only catalog provenance during the marketplace upgrade", async () => {
    const db = await createConnection(":memory:");
    try {
      await db.$client.exec(`
        CREATE TABLE plugins (
          id text PRIMARY KEY NOT NULL,
          provenance text NOT NULL,
          catalog_entry_id text
        );
        INSERT INTO plugins VALUES
          ('catalog-plugin', 'catalog', 'catalog-entry'),
          ('direct-plugin', 'direct', NULL),
          ('builtin-plugin', 'builtin', NULL);
      `);

      runMigrationFile({
        db,
        migrationPath: namedMarketplaceCatalogMigrationPath,
      });

      expect(
        await db.$client
          .prepare<[], MigratedNamedCatalogProvenanceRow>(
            `
              SELECT id,
                catalog_marketplace_name AS catalogMarketplaceName
              FROM plugins
              ORDER BY id
            `,
          )
          .all(),
      ).toEqual([
        { id: "builtin-plugin", catalogMarketplaceName: null },
        { id: "catalog-plugin", catalogMarketplaceName: "hyperfide-official" },
        { id: "direct-plugin", catalogMarketplaceName: null },
      ]);
    } finally {
      await closeConnection(db);
    }
  });

  it("seeds the Keep Awake configuration from the legacy preference", async () => {
    const db = await createConnection(":memory:");
    try {
      await migrate(db);
      await db.$client.exec(`
        INSERT INTO app_settings (id, caffeinate, updated_at)
        VALUES ('current', 1, 123)
        ON CONFLICT (id) DO UPDATE SET caffeinate = 1, updated_at = 123;
        DELETE FROM plugin_kv
        WHERE plugin_id = 'keep-awake' AND key = 'configuration';
      `);
      await migrate(db);
      expect(
        await db.$client
          .prepare<
            [],
            {
              key: string;
              pluginId: string;
              updatedAt: number;
              value: string;
            }
          >(
            `
              SELECT
                plugin_id AS pluginId,
                key,
                value,
                updated_at AS updatedAt
              FROM plugin_kv
              WHERE plugin_id = 'keep-awake' AND key = 'configuration'
            `,
          )
          .get(),
      ).toEqual({
        pluginId: "keep-awake",
        key: "configuration",
        value: JSON.stringify({
          enabled: true,
          selection: { mode: "all" },
        }),
        updatedAt: 123,
      });
    } finally {
      await closeConnection(db);
    }
  });

  it("backfills legacy side-chat rows to hidden visibility", async () => {
    const db = await createConnection(":memory:");
    try {
      await migrate(db);
      const host = await upsertHost(db, noopNotifier, {
        id: "host-side-chat-visibility",
        name: "Migration Host",
      });
      const { project } = await createProject(db, noopNotifier, {
        name: "Migration Project",
        source: {
          type: "local_path",
          hostId: host.id,
          path: "/tmp/side-chat-visibility",
        },
      });
      const originKindSideChat = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        originKind: "fork",
      });
      await restoreLegacyThreadOriginColumn(db);
      const legacyOriginSideChat = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      const fork = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        originKind: "fork",
      });
      await db.$client
        .prepare("UPDATE threads SET origin_kind = 'side-chat' WHERE id = ?")
        .run(originKindSideChat.id);
      await db.$client
        .prepare("UPDATE threads SET child_origin = 'side-chat' WHERE id = ?")
        .run(legacyOriginSideChat.id);

      await dropSideChatPluginExperimentColumn(db);
      runMigrationFile({
        db,
        migrationPath: sideChatVisibilityBackfillMigrationPath,
      });

      expect(
        (
          await db.$client
            .prepare<[], MigratedThreadVisibilityRow>(
              "SELECT id, visibility FROM threads ORDER BY id",
            )
            .all()
        )
          .filter((row) =>
            [originKindSideChat.id, legacyOriginSideChat.id, fork.id].includes(
              row.id,
            ),
          )
          .sort((left, right) => left.id.localeCompare(right.id)),
      ).toEqual(
        [
          { id: originKindSideChat.id, visibility: "hidden" },
          { id: legacyOriginSideChat.id, visibility: "hidden" },
          { id: fork.id, visibility: "visible" },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );
    } finally {
      await closeConnection(db);
    }
  });

  it("backfills normalized parent tool-call ids from legacy event payloads", async () => {
    const db = await createConnection(":memory:");

    try {
      await migrate(db);
      const host = await upsertHost(db, noopNotifier, {
        name: "event-parent-migration-host",
      });
      const { project } = await createProject(db, noopNotifier, {
        name: "event-parent-migration-project",
        source: {
          type: "local_path",
          hostId: host.id,
          path: "/tmp/event-parent-migration",
        },
      });
      const thread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });

      await rewindEnvironmentRowFactsMigration(db);
      await rewindEnvironmentProvidersMigration(db);
      await dropEventParentToolCallIdColumn(db);
      await dropMarketplaceStatsColumn(db);
      await dropQueueReworkSchema(db);
      await db.$client
        .prepare<DeleteMigrationParameters>(
          "DELETE FROM __drizzle_migrations WHERE created_at >= ?",
        )
        .run(eventParentToolCallMigrationWhen);
      await db.$client.exec(`
        INSERT INTO events (
          id, thread_id, scope_kind, turn_id, sequence, type, item_id, item_kind, data, created_at
        ) VALUES
          (
            'evt_top_level_parent',
            '${thread.id}',
            'turn',
            'legacy-turn',
            1,
            'turn/started',
            NULL,
            NULL,
            '{"parentToolCallId":"parent-top-level"}',
            1
          ),
          (
            'evt_item_parent',
            '${thread.id}',
            'turn',
            'legacy-turn',
            2,
            'item/completed',
            'child-message',
            'agentMessage',
            '{"item":{"id":"child-message","type":"agentMessage","parentToolCallId":"parent-item"}}',
            2
          ),
          (
            'evt_no_parent',
            '${thread.id}',
            'thread',
            NULL,
            3,
            'system/error',
            NULL,
            NULL,
            '{"message":"parentToolCallId is only text here"}',
            3
          ),
          (
            'evt_malformed_parent',
            '${thread.id}',
            'thread',
            NULL,
            4,
            'system/error',
            NULL,
            NULL,
            '{"parentToolCallId":',
            4
          );
      `);

      await migrate(db);

      expect(
        await db.$client
          .prepare<[], MigratedEventParentRow>(
            `
              SELECT id, parent_tool_call_id AS parentToolCallId
              FROM events
              WHERE id LIKE 'evt_%_parent'
              ORDER BY id
            `,
          )
          .all(),
      ).toEqual([
        { id: "evt_item_parent", parentToolCallId: "parent-item" },
        { id: "evt_malformed_parent", parentToolCallId: null },
        { id: "evt_no_parent", parentToolCallId: null },
        { id: "evt_top_level_parent", parentToolCallId: "parent-top-level" },
      ]);
      expect(await readIndexNames({ db, tableName: "events" })).toContain(
        "events_parent_tool_call_thread_parent_sequence_idx",
      );
    } finally {
      await closeConnection(db);
    }
  });
});

describe.skipIf(isPostgresTest)("environment providers migration", () => {
  const environmentProvidersMigrationWhen = 1788386943764;

  async function seedPreProviderEnvironments(db: DbConnection): Promise<void> {
    await db.$client.prepare("DROP TABLE provider_model_catalogs").run();
    await db.$client
      .prepare("DROP TABLE IF EXISTS ui_preference_defaults")
      .run();
    await db.$client.prepare("DROP TABLE ui_preferences").run();
    await db.$client.prepare("DROP TABLE retained_event_outputs").run();
    await rewindEnvironmentRowFactsMigration(db);
    await rewindEnvironmentProvidersMigration(db);
    await dropQueuedMessageAttemptColumns(db);
    await db.$client
      .prepare<[number]>(
        "DELETE FROM __drizzle_migrations WHERE created_at >= ?",
      )
      .run(environmentProvidersMigrationWhen);
    await db.$client.exec(`
      INSERT INTO hosts (id, name, type, created_at, updated_at)
      VALUES ('host_ep', 'provider host', 'persistent', 1000, 1000);

      INSERT INTO projects (id, name, created_at, updated_at)
      VALUES ('proj_ep', 'provider project', 1000, 1000);

      INSERT INTO environments (
        id, project_id, host_id, path, managed, base_branch,
        retire_requested_at, destroy_attempt_id, workspace_provision_type,
        status, created_at, updated_at
      ) VALUES
        ('env_named', 'proj_ep', 'host_ep', '/w/named', 1, 'release/1.2',
         NULL, NULL, 'managed-worktree', 'ready', 1000, 1000),
        ('env_default', 'proj_ep', 'host_ep', '/w/default', 1, NULL,
         NULL, NULL, 'managed-worktree', 'ready', 1000, 1000),
        ('env_personal', 'proj_ep', 'host_ep', '/w/personal', 1, NULL,
         NULL, NULL, 'personal', 'ready', 1000, 1000),
        ('env_personal_gone', 'proj_ep', 'host_ep', NULL, 1, NULL,
         NULL, NULL, 'personal', 'destroyed', 1000, 1000),
        ('env_retiring', 'proj_ep', 'host_ep', '/w/retiring', 1, NULL,
         5000, NULL, 'managed-worktree', 'retiring', 1000, 1000),
        ('env_destroying', 'proj_ep', 'host_ep', '/w/destroying', 1, NULL,
         5000, 'rpc_attempt', 'managed-worktree', 'destroying', 1000, 1000),
        ('env_unmanaged', 'proj_ep', 'host_ep', '/w/unmanaged', 0, NULL,
         NULL, NULL, 'unmanaged', 'ready', 1000, 1000);
    `);
    const insertPendingThread = await db.$client.prepare<[string, string]>(
      `INSERT INTO threads (
         id, project_id, provider_id, status, pending_start_context,
         latest_attention_at, created_at, updated_at
       ) VALUES (?, 'proj_ep', 'codex', 'pending', ?, 1000, 1000, 1000)`,
    );
    await insertPendingThread.run(
      "thr_worktree_pending",
      JSON.stringify({
        environmentIntent: {
          type: "direct-managed",
          hostId: "host_ep",
          sourcePath: "/checkouts/hyperfide",
          baseBranch: { kind: "named", name: "release/1.2" },
          workspaceProvisionType: "managed-worktree",
        },
      }),
    );
    await insertPendingThread.run(
      "thr_personal_pending",
      JSON.stringify({
        environmentIntent: {
          type: "direct-personal",
          hostId: "host_ep",
          workspaceProvisionType: "personal",
        },
      }),
    );
  }

  async function readPendingStartContext(db: DbConnection, threadId: string) {
    const row = await db.$client
      .prepare<[string], { startupContext: string | null }>(
        `SELECT startup_context AS startupContext
           FROM threads WHERE id = ?`,
      )
      .get(threadId);
    return JSON.parse(row?.startupContext ?? "null") as unknown;
  }

  it("records bundled plugin owners while migrating legacy environments", async () => {
    const db = await createMigratedConnection();
    try {
      await seedPreProviderEnvironments(db);
      await migrate(db);
      const rows = await db.$client
        .prepare<[], { provider: string; owner: string | null }>(
          "SELECT DISTINCT environment_provider_id AS provider, environment_provider_plugin_id AS owner FROM environments ORDER BY provider",
        )
        .all();
      expect(rows).toEqual([
        { provider: "git-worktree", owner: "environment-git-worktree" },
        {
          provider: "personal-workspace",
          owner: "environment-personal-workspace",
        },
        { provider: "project-checkout", owner: "environment-project-checkout" },
      ]);
    } finally {
      await db.close();
    }
  });

  it("hands managed worktree, personal, and attached rows to their providers", async () => {
    const db = await createMigratedConnection();

    try {
      await seedPreProviderEnvironments(db);

      await migrate(db);

      expect(
        await db.$client
          .prepare<[], BackfilledEnvironmentRow>(
            `
              SELECT id,
                     environment_provider_id AS environmentProviderId,
                     environment_provider_selection AS environmentProviderSelection,
                     environment_provider_instance_key AS environmentProviderInstanceKey
              FROM environments
              ORDER BY id
            `,
          )
          .all(),
      ).toEqual([
        {
          id: "env_default",
          environmentProviderId: "git-worktree",
          environmentProviderSelection:
            '{"machine":{"type":"existing","hostId":"host_ep"},"inputs":{"branch":{"kind":"default"}}}',
          environmentProviderInstanceKey: null,
        },
        {
          id: "env_destroying",
          environmentProviderId: "git-worktree",
          environmentProviderSelection:
            '{"machine":{"type":"existing","hostId":"host_ep"},"inputs":{"branch":{"kind":"default"}}}',
          environmentProviderInstanceKey: null,
        },
        {
          id: "env_named",
          environmentProviderId: "git-worktree",
          environmentProviderSelection:
            '{"machine":{"type":"existing","hostId":"host_ep"},"inputs":{"branch":{"kind":"named","name":"release/1.2"}}}',
          environmentProviderInstanceKey: null,
        },
        {
          id: "env_personal",
          environmentProviderId: "personal-workspace",
          environmentProviderSelection:
            '{"machine":{"type":"existing","hostId":"host_ep"},"inputs":null}',
          environmentProviderInstanceKey: null,
        },
        {
          id: "env_personal_gone",
          environmentProviderId: "personal-workspace",
          environmentProviderSelection:
            '{"machine":{"type":"existing","hostId":"host_ep"},"inputs":null}',
          environmentProviderInstanceKey: null,
        },
        {
          id: "env_retiring",
          environmentProviderId: "git-worktree",
          environmentProviderSelection:
            '{"machine":{"type":"existing","hostId":"host_ep"},"inputs":{"branch":{"kind":"default"}}}',
          environmentProviderInstanceKey: null,
        },
        {
          id: "env_unmanaged",
          environmentProviderId: "project-checkout",
          environmentProviderSelection:
            '{"machine":{"type":"existing","hostId":"host_ep"},"inputs":{"path":"/w/unmanaged"}}',
          environmentProviderInstanceKey: null,
        },
      ]);
    } finally {
      await closeConnection(db);
    }
  });

  it("hands main's path-less legacy rows to each environment provider", async () => {
    const db = await createMigratedConnection();

    try {
      await seedPreProviderEnvironments(db);
      await db.$client.exec(`
        INSERT INTO environments (
          id, project_id, host_id, path, managed, base_branch,
          retire_requested_at, destroy_attempt_id, workspace_provision_type,
          status, created_at, updated_at
        ) VALUES
          ('env_pathless_managed', 'proj_ep', 'host_ep', NULL, 1, NULL,
           NULL, NULL, 'managed-worktree', 'error', 1000, 1000),
          ('env_pathless_personal', 'proj_ep', 'host_ep', NULL, 1, NULL,
           NULL, NULL, 'personal', 'error', 1000, 1000),
          ('env_pathless_unmanaged', 'proj_ep', 'host_ep', NULL, 0, NULL,
           NULL, NULL, 'unmanaged', 'error', 1000, 1000);
      `);

      await migrate(db);

      expect(
        await db.$client
          .prepare<
            [],
            {
              environmentProviderId: string | null;
              environmentProviderSelection: string | null;
              id: string;
              isWorktree: number;
              path: string | null;
              providerOwnsPath: number;
              status: string;
            }
          >(
            `
              SELECT id,
                     path,
                     status,
                     environment_provider_id AS environmentProviderId,
                     environment_provider_selection AS environmentProviderSelection,
                     is_worktree AS isWorktree,
                     provider_owns_path AS providerOwnsPath
              FROM environments
              WHERE id LIKE 'env_pathless_%'
              ORDER BY id
            `,
          )
          .all(),
      ).toEqual([
        {
          id: "env_pathless_managed",
          path: null,
          status: "error",
          environmentProviderId: "git-worktree",
          environmentProviderSelection:
            '{"machine":{"type":"existing","hostId":"host_ep"},"inputs":{"branch":{"kind":"default"}}}',
          isWorktree: 1,
          providerOwnsPath: 1,
        },
        {
          id: "env_pathless_personal",
          path: null,
          status: "error",
          environmentProviderId: "personal-workspace",
          environmentProviderSelection:
            '{"machine":{"type":"existing","hostId":"host_ep"},"inputs":null}',
          isWorktree: 0,
          providerOwnsPath: 1,
        },
        {
          id: "env_pathless_unmanaged",
          path: null,
          status: "error",
          environmentProviderId: "project-checkout",
          environmentProviderSelection:
            '{"machine":{"type":"existing","hostId":"host_ep"},"inputs":{}}',
          isWorktree: 0,
          providerOwnsPath: 0,
        },
      ]);
    } finally {
      await closeConnection(db);
    }
  });

  it("backfills the worktree and path-ownership row facts by provider", async () => {
    const db = await createMigratedConnection();

    try {
      await seedPreProviderEnvironments(db);

      await migrate(db);

      expect(
        await db.$client
          .prepare<
            [],
            { id: string; isWorktree: number; providerOwnsPath: number }
          >(
            `
              SELECT id,
                     is_worktree AS isWorktree,
                     provider_owns_path AS providerOwnsPath
              FROM environments
              ORDER BY id
            `,
          )
          .all(),
      ).toEqual([
        { id: "env_default", isWorktree: 1, providerOwnsPath: 1 },
        { id: "env_destroying", isWorktree: 1, providerOwnsPath: 1 },
        { id: "env_named", isWorktree: 1, providerOwnsPath: 1 },
        { id: "env_personal", isWorktree: 0, providerOwnsPath: 1 },
        { id: "env_personal_gone", isWorktree: 0, providerOwnsPath: 1 },
        { id: "env_retiring", isWorktree: 1, providerOwnsPath: 1 },
        { id: "env_unmanaged", isWorktree: 0, providerOwnsPath: 0 },
      ]);
    } finally {
      await closeConnection(db);
    }
  });

  it.skipIf(isPostgresTest)(
    "settles retiring and destroying rows and drops core's retire, destroy and provision type columns",
    async () => {
      const db = await createMigratedConnection();

      try {
        await seedPreProviderEnvironments(db);

        await migrate(db);

        expect(
          await db.$client
            .prepare<[], { id: string; status: string }>(
              "SELECT id, status FROM environments ORDER BY id",
            )
            .all(),
        ).toEqual([
          { id: "env_default", status: "ready" },
          { id: "env_destroying", status: "error" },
          { id: "env_named", status: "ready" },
          { id: "env_personal", status: "ready" },
          { id: "env_personal_gone", status: "destroyed" },
          { id: "env_retiring", status: "ready" },
          { id: "env_unmanaged", status: "ready" },
        ]);

        const environmentColumns = (
          await db.$client
            .prepare<[], TableInfoRow>("PRAGMA table_info(environments)")
            .all()
        ).map((column) => column.name);
        expect(environmentColumns).not.toContain("managed");
        expect(environmentColumns).not.toContain("retire_requested_at");
        expect(environmentColumns).not.toContain("destroy_attempt_id");
        expect(environmentColumns).not.toContain("workspace_provision_type");
      } finally {
        await closeConnection(db);
      }
    },
  );

  it("rewrites pending threads' stored direct intents into provider selections", async () => {
    const db = await createMigratedConnection();

    try {
      await seedPreProviderEnvironments(db);

      await migrate(db);

      expect(await readPendingStartContext(db, "thr_worktree_pending")).toEqual(
        {
          kind: "pending",
          environmentIntent: {
            type: "provider",
            environmentProviderId: "git-worktree",
            machine: { type: "existing", hostId: "host_ep" },
            inputs: { branch: { kind: "named", name: "release/1.2" } },
          },
        },
      );
      expect(await readPendingStartContext(db, "thr_personal_pending")).toEqual(
        {
          kind: "pending",
          environmentIntent: {
            type: "provider",
            environmentProviderId: "personal-workspace",
            machine: { type: "existing", hostId: "host_ep" },
            inputs: null,
          },
        },
      );
    } finally {
      await closeConnection(db);
    }
  });
});

describe.skipIf(isPostgresTest)("machine providers migration", () => {
  it("backfills server access for machines with a legacy access identity", async () => {
    const db = await createConnection(":memory:");
    try {
      await db.$client.exec(`
        CREATE TABLE hosts (
          id text PRIMARY KEY NOT NULL,
          name text NOT NULL,
          type text NOT NULL,
          connect_machine_id text,
          destroyed_at integer
        );
        CREATE TABLE project_sources (id text PRIMARY KEY NOT NULL);
        CREATE TABLE host_daemon_sessions (
          id text PRIMARY KEY NOT NULL,
          host_type text NOT NULL
        );
        CREATE TEMP TABLE hyperfide_migration_local_host (id text PRIMARY KEY NOT NULL);
        INSERT INTO hosts VALUES
          ('legacy', 'Legacy', 'persistent', 'cloud-machine', NULL),
          ('direct', 'Direct', 'persistent', NULL, NULL);
      `);

      runMigrationFile({ db, migrationPath: machineProvidersMigrationPath });

      expect(
        await db.$client
          .prepare<[], { id: string; providerId: string | null; type: string }>(
            "SELECT id, server_access_provider_id AS providerId, type FROM hosts ORDER BY id",
          )
          .all(),
      ).toEqual([
        { id: "direct", providerId: null, type: "persistent" },
        { id: "legacy", providerId: "connect", type: "persistent" },
      ]);
    } finally {
      await closeConnection(db);
    }
  });
});

describe.skipIf(isPostgresTest)(
  "environment and thread startup ownership migration",
  () => {
    it.each(["creating", "cancelled"])(
      "preserves %s allocation checkpoints and keeps attached environment resources authoritative",
      async (phase) => {
        const db = await createMigratedConnection();
        try {
          await rewindMachineProvidersMigration(db);
          await rewindEnvironmentProvisioningMigration(db);
          await dropQueuedMessageAttemptColumns(db);
          const legacySchema = readFileSync(
            resolve(
              dirname(fileURLToPath(import.meta.url)),
              "../drizzle/0113_environment_providers.sql",
            ),
            "utf8",
          ).split("--> statement-breakpoint")[0]!;
          await db.$client.exec(legacySchema);
          await db.$client.exec(
            "DROP TABLE IF EXISTS environment_hook_operations",
          );
          await db.$client
            .prepare<[number]>(
              "DELETE FROM __drizzle_migrations WHERE created_at >= ?",
            )
            .run(environmentProvisioningMigrationWhen);
          await db.$client.exec(`
        INSERT INTO hosts (id, name, type, created_at, updated_at) VALUES ('host_ownership', 'test', 'persistent', 1, 1);
        INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj_ownership', 'test', 1, 1);
        INSERT INTO threads (id, project_id, provider_id, status, latest_attention_at, created_at, updated_at)
          VALUES ('thr_creating', 'proj_ownership', 'codex', 'starting', 1, 1, 1), ('thr_attached', 'proj_ownership', 'codex', 'starting', 1, 1, 1);
        INSERT INTO environments (id, project_id, host_id, path, status, resource, created_at, updated_at)
          VALUES ('env_attached', 'proj_ownership', 'host_ownership', '/tmp/attached', 'ready', '{"new":"checkpoint"}', 1, 1);
      `);
          const request = {
            clientRequestId: "request",
            environmentIntent: {
              type: "provider",
              environmentProviderId: "test",
              machine: { type: "existing", hostId: "host_ownership" },
              inputs: null,
            },
            input: [{ type: "text", text: "original message" }],
          };
          const selection = JSON.stringify({
            machine: { type: "existing", hostId: "host_ownership" },
            inputs: null,
          });
          const insert = await db.$client
            .prepare(`INSERT INTO environment_launches (thread_id, provider_id, provider_plugin_id, path_rejected, attempt, phase, started_at, failed_at, failure, message, transient_failures, path_key, host_id, path, claim_path, owns_path, resource, step_text, pending_log, environment_id, selection, request, cancel_pending)
        VALUES (?, 'test', 'test-plugin', 0, 3, ?, 20, NULL, NULL, NULL, 1, 'stable-key', 'host_ownership', ?, ?, 1, ?, 'Preparing', 'output', ?, ?, ?, 0)`);
          await insert.run(
            "thr_creating",
            "creating",
            "/tmp/creating",
            "/tmp/creating",
            '{"allocated":"resource"}',
            null,
            selection,
            JSON.stringify(request),
          );
          await insert.run(
            "thr_attached",
            "ready",
            "/tmp/attached",
            "/tmp/attached",
            '{"old":"checkpoint"}',
            "env_attached",
            selection,
            JSON.stringify(request),
          );
          if (phase === "cancelled")
            await db.$client.exec(
              "UPDATE environment_launches SET phase = 'cancelled', cancel_pending = 1 WHERE thread_id = 'thr_creating'",
            );
          await migrate(db);
          expect(
            await db.$client
              .prepare(
                "SELECT teardown_status FROM environments WHERE owner_thread_id = 'thr_creating'",
              )
              .get(),
          ).toEqual({
            teardown_status: phase === "cancelled" ? "running" : null,
          });
          const resource = await db.$client
            .prepare(
              "SELECT id, resource, attempt, claim_path FROM environments WHERE owner_thread_id = 'thr_creating'",
            )
            .get();
          expect(resource).toEqual({
            id: "env_provision_thr_creating",
            resource: '{"allocated":"resource"}',
            attempt: 3,
            claim_path: "/tmp/creating",
          });
          expect(
            await db.$client
              .prepare(
                "SELECT resource FROM environments WHERE id = 'env_attached'",
              )
              .get(),
          ).toEqual({ resource: '{"new":"checkpoint"}' });
          const stored = (await db.$client
            .prepare<[], { startup_context: string }>(
              "SELECT startup_context FROM threads WHERE id = 'thr_creating'",
            )
            .get())!;
          expect(JSON.parse(stored.startup_context).state).not.toHaveProperty(
            "stage",
          );
          expect(JSON.parse(stored.startup_context)).toMatchObject({
            kind: "provisioning",
            request,
            state: {
              environmentId: null,
              provisioningId: "provision_migrated_thr_creating",
            },
          });
          expect(
            await db.$client
              .prepare(
                "SELECT name FROM sqlite_master WHERE name = 'environment_launches'",
              )
              .get(),
          ).toBeUndefined();
          expect(
            await db.$client.prepare("PRAGMA foreign_key_check").all(),
          ).toEqual([]);
        } finally {
          await closeConnection(db);
        }
      },
    );
  },
);
