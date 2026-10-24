# PostgreSQL storage

Set `HYPERFIDE_DATABASE_URL` before starting the server. A `postgres://` or
`postgresql://` URL selects PostgreSQL through Drizzle and node-postgres. An unset
value retains the configured SQLite data-directory path; a file path or `sqlite:`
URL selects SQLite through better-sqlite3. PostgreSQL connections use the
`platform` schema. Socket parameters in the URL are supported.

The main data API and transactions return promises on both engines. Await all
reads, writes, migrations and connection closure. `afterCommit` runs callbacks
only after a successful commit; rolled-back savepoint callbacks are discarded.
PostgreSQL transactions use an advisory writer lock to preserve atomic sequence
allocation and the read-modify-write ordering provided by SQLite transactions.
PostgreSQL tracks event changes by connection in the internal
`platform.__hyperfide_changes` table, so timeline caches detect writes from other
connections without discarding incremental work after their own appends.

The SQLite migration history remains in `packages/db/drizzle`. PostgreSQL has a
baseline and append-only journal in `packages/db/drizzle-postgres`. Generate both
with `pnpm -C platform/packages/db db:generate`; review both outputs together.
`dialect-parity.test.ts` compares every declared table and column and checks the
migrated database against that declaration on both engines. Existing SQLite data
is not copied automatically to PostgreSQL.

`pnpm -C platform/packages/db db:studio` selects the configured dialect. The reset
command resets the configured database after its existing confirmation, including
the PostgreSQL `platform` schema. Local directory cleanup still follows the reset
command's selected targets.

The SDK exports the `PluginAsyncDatabase` interface for this storage handle.

Plugins can use `await storage.asyncDatabase()` on either engine. Its `query`,
`execute`, `transaction`, `migrate` and `close` methods return promises. Supply
native placeholders (`?` on SQLite, `$1` on PostgreSQL), and select dialect-specific
SQL through the handle's `dialect` property where necessary. PostgreSQL plugin
schemas are isolated by a hash of the plugin id. Ordered migrations are
transactional, append-only and checked by statement hash.

The existing synchronous `storage.database()` and `storage.migrate()` API remains
SQLite-based for compatibility. These bundled plugins still use that API and are
follow-up candidates for task 6.6: Account Pooler, Automations,
Docs, GitHub, Memory, Prompt Library, Side chat, Storage & retention, Tasks and
Workflows. Their databases do not move to PostgreSQL when the server database
configuration changes.

Run `bash tests/hyperfide/cases/v22/6_1.sh` for db and server suites on SQLite and
an owned temporary PostgreSQL cluster, portable plugin storage integration tests,
and the changed-file identity gate. Historical SQLite
migration repair, PRAGMA/WAL diagnostics and SQLite query-plan tests apply only to
SQLite; portable data behavior runs on both engines.

Server-move archives currently contain physical SQLite backups. That archive
transfer workflow and its tests remain SQLite-specific; PostgreSQL deployments
use database-native backup and relocation tools.
