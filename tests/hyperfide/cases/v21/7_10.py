#!/usr/bin/env python3
"""hyperfide-v21 7.10: dead modules and tables stay removed.

Applies every migration to a fresh database on DATABASE_URL (run it under
tests/hyperfide/support/withpg.py) and proves that migration 0716 dropped the five
tables nothing read or wrote, that a query naming one of them now fails, that the
kept candidate_evidence table is still there, and that the authority schema check
(storage/schema.ts bootstrapAuthoritySchema) accepts the fully migrated schema.
Without a database it still proves that the two removed modules, their only test
callers and the nine unused type guards are gone, that importing a removed module
from the built dist fails, and that scripts/index.html is untracked.
Exit 0 on success, 1 on any failed assertion, 77 when DATABASE_URL is unset (the
source checks have run and passed by then).
"""
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[4]
SERVICE = ROOT / 'core/control-plane'
DROPPED = ['resource_cleanup_receipts', 'runner_command_receipts', 'preparation_references',
           'branch_observations', 'review_coverage_inputs']
KEPT = ['candidate_evidence']
REMOVED = ['core/control-plane/src/preparation/checkpoint.ts', 'core/control-plane/src/transport/writer_observation.ts',
           'tests/hyperfide/cases/tasks/14_writer_observation_transport.py', 'tests/hyperfide/cases/support/checkpoint_source.py']
GUARDS = ['isConnectorQualificationAuthority', 'isAgentSessionsCapability', 'isEventInboxCapability', 'isEventOutboxCapability',
          'isHierarchyAuthority', 'isFrontierRouteAuthority', 'isPlacementAuthority', 'isWorkerRegistrationAuthority',
          'isArtifactAdoptionCapability']
DATABASE = 'hf_v21_7_10'
FAILED = []


def check(name, operation):
    try:
        operation()
        actual = 'observed'
    except Exception as error:
        FAILED.append(name)
        actual = type(error).__name__ + ': ' + str(error)
    print(json.dumps({'type': 'assertion', 'id': name, 'expected': 'observed', 'actual': actual}), flush=True)


def expect(condition, message):
    if not condition:
        raise AssertionError(message)


def node(script, env_extra=None, fails=False):
    env = os.environ.copy()
    env.update(env_extra or {})
    p = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT, env=env, text=True, capture_output=True, timeout=180)
    if fails:
        expect(p.returncode != 0, 'node probe unexpectedly succeeded')
        return p.stderr
    expect(p.returncode == 0, 'node probe failed: ' + p.stderr[-1500:])
    return json.loads(p.stdout) if p.stdout.strip() else None


SQL_JS = r"""
import {createRequire} from 'node:module';
const pg=createRequire(process.cwd()+'/core/control-plane/package.json')('pg');
const c=new pg.Client({connectionString:process.env.HF_PG_URL});await c.connect();
try{let rows=[];for(const s of JSON.parse(process.env.HF_SQL))rows=(await c.query(s)).rows;process.stdout.write(JSON.stringify(rows));}
catch(e){process.stderr.write(String(e.code)+': '+e.message);process.exitCode=1;}
finally{await c.end();}
"""

MIGRATE_JS = r"""
import {createResourceContainer} from './core/control-plane/dist/storage/runtime.js';
import {MigrationCoordinator} from './core/control-plane/dist/storage/durability.js';
const signal=new AbortController().signal,env={...process.env,DATABASE_URL:process.env.HF_PG_URL,HYPERFIDE_MIGRATION_DATABASE_URL:process.env.HF_PG_URL};
const r=createResourceContainer({role:'control',env,signal});
try{process.stdout.write(JSON.stringify(await new MigrationCoordinator(r).apply({timeoutMs:30000,signal})));}
finally{await r.close();}
"""

BOOTSTRAP_JS = r"""
import {createRequire} from 'node:module';
import {AUTHORITY_TABLES,bootstrapAuthoritySchema} from './core/control-plane/dist/storage/schema.js';
const pg=createRequire(process.cwd()+'/core/control-plane/package.json')('pg');
const pool=new pg.Pool({connectionString:process.env.HF_PG_URL,max:1});
try{const receipt=await bootstrapAuthoritySchema(pool);process.stdout.write(JSON.stringify({declared:[...AUTHORITY_TABLES],tables:receipt.tables,applied:receipt.applied}));}
finally{await pool.end();}
"""


def sql(url, statements, fails=False):
    return node(SQL_JS, {'HF_PG_URL': url, 'HF_SQL': json.dumps(statements)}, fails=fails)


def database_url(base, name):
    parts = urlsplit(base)
    return urlunsplit(parts._replace(path='/' + name))


def source_checks():
    def removed():
        present = [path for path in REMOVED if (ROOT / path).exists()]
        expect(not present, ('removed files are back', present))
    check('v21.7.10.modules-removed', removed)

    def no_import():
        hits = subprocess.run(['git', 'grep', '-n', '-E', r'writer_observation\.js|preparation/checkpoint\.js|from .\./checkpoint\.js', '--',
                               'core/control-plane/src', 'tests/hyperfide/cases', 'tests/hyperfide/support'],
                              cwd=ROOT, text=True, capture_output=True).stdout
        expect(hits == '', ('a removed module is still imported', hits[:800]))
    check('v21.7.10.no-importer', no_import)

    def dist_import_fails():
        # A stale dist keeps the old outputs: rebuild from a clean dist before qualifying.
        for module in ['transport/writer_observation.js', 'preparation/checkpoint.js']:
            err = node("await import('./core/control-plane/dist/" + module + "');", fails=True)
            expect('ERR_MODULE_NOT_FOUND' in err, ('import of a removed module did not fail as absent', module, err[-300:]))
    check('v21.7.10.dist-import-fails', dist_import_fails)

    def guards_removed():
        hits = subprocess.run(['git', 'grep', '-n', '-w', '-E', '|'.join(GUARDS), '--', 'core/control-plane/src'],
                              cwd=ROOT, text=True, capture_output=True).stdout
        expect(hits == '', ('an unused type guard is back', hits[:800]))
    check('v21.7.10.type-guards-removed', guards_removed)

    def index_untracked():
        tracked = subprocess.run(['git', 'ls-files', '--', 'scripts/index.html'], cwd=ROOT, text=True, capture_output=True).stdout
        expect(tracked == '', 'scripts/index.html is tracked')
    check('v21.7.10.index-html-untracked', index_untracked)


def database_checks(base):
    sql(base, ['DROP DATABASE IF EXISTS ' + DATABASE, 'CREATE DATABASE ' + DATABASE])
    url = database_url(base, DATABASE)
    try:
        def migrated():
            applied = node(MIGRATE_JS, {'HF_PG_URL': url})
            expect(716 in applied['applied'], ('0716 was not applied', applied))
        check('v21.7.10.migrations-apply', migrated)

        def dropped():
            rows = sql(url, ["SELECT t AS name,to_regclass('hyperfide.'||t)::text AS reg FROM unnest(ARRAY%s::text[]) t" % json.dumps(DROPPED + KEPT).replace('"', "'")])
            state = {row['name']: row['reg'] for row in rows}
            expect(all(state[t] is None for t in DROPPED), ('a dropped table exists', state))
            expect(all(state[t] for t in KEPT), ('a kept table is missing', state))
        check('v21.7.10.tables-dropped-candidate-evidence-kept', dropped)

        def reference_fails():
            # The same query on a kept table succeeds, so the failure below is the drop and not the connection.
            sql(url, ['SELECT count(*) FROM hyperfide.' + KEPT[0]])
            for table in DROPPED:
                err = sql(url, ['SELECT count(*) FROM hyperfide.' + table], fails=True)
                expect(err.startswith('42P01'), ('query on a dropped table did not fail as undefined', table, err[:200]))
        check('v21.7.10.dropped-table-reference-fails', reference_fails)

        def authority_schema():
            receipt = node(BOOTSTRAP_JS, {'HF_PG_URL': url})
            expect(not set(DROPPED) & set(receipt['declared']), ('authority inventory still declares a dropped table', receipt['declared']))
            expect(set(receipt['declared']) <= set(receipt['tables']) and receipt['applied'] is False, receipt)
        check('v21.7.10.authority-schema-accepts-migrated', authority_schema)
    finally:
        sql(base, ["SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='" + DATABASE + "' AND pid<>pg_backend_pid()",
                   'DROP DATABASE IF EXISTS ' + DATABASE])


def main():
    source_checks()
    base = os.environ.get('DATABASE_URL')
    if not base:
        print('SKIP: DATABASE_URL unset; database checks not run', flush=True)
        return 1 if FAILED else 77
    database_checks(base)
    return 1 if FAILED else 0


if __name__ == '__main__':
    sys.exit(main())
