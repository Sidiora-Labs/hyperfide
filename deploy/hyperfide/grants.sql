-- Trusted operator only, after migrations, for each existing runtime login:
-- psql "$OPERATOR_DATABASE_URL" -v runtime_role=hyperfide_control -f grants.sql
-- Repeat for provisioner and dispatch. Never expose operator credentials to runtime.
-- The database owner that ran the migrations is sufficient unless pg_control
-- EXECUTE was revoked from PUBLIC; then a superuser must run it (see below).
-- No default privileges: review and rerun after an operator applies new migrations.
\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('hyperfide.grant_runtime_role', :'runtime_role', true);
DO $$
DECLARE target oid;
BEGIN
  SELECT oid INTO STRICT target FROM pg_roles
    WHERE rolname = current_setting('hyperfide.grant_runtime_role');
  IF EXISTS (SELECT 1 FROM pg_roles WHERE oid=target AND
      (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
    OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner=target)
    OR EXISTS (SELECT 1 FROM pg_class WHERE relowner=target)
    OR EXISTS (SELECT 1 FROM pg_database WHERE datdba=target)
    OR EXISTS (SELECT 1 FROM pg_roles WHERE oid<>target AND pg_has_role(target,oid,'MEMBER'))
  THEN RAISE EXCEPTION 'Runtime role must be unprivileged, own no objects, and have no role memberships';
  END IF;
END $$;
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'runtime_role') \gexec
SELECT format('REVOKE CREATE ON DATABASE %I FROM %I', current_database(), :'runtime_role') \gexec
REVOKE CREATE ON SCHEMA hyperfide FROM :"runtime_role";
GRANT USAGE ON SCHEMA hyperfide TO :"runtime_role";
GRANT SELECT ON ALL TABLES IN SCHEMA hyperfide TO :"runtime_role";
SELECT format('GRANT INSERT, UPDATE, DELETE ON TABLE %I.%I TO %I', schemaname, tablename, :'runtime_role')
  FROM pg_tables WHERE schemaname='hyperfide' AND tablename<>'schema_migrations' \gexec
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON hyperfide.schema_migrations FROM :"runtime_role";
-- Topology observation (storage/replicas.ts) needs EXECUTE on the pg_control
-- functions. They default to PUBLIC EXECUTE, so a database-owner operator only
-- verifies it. If a cluster revoked that default, only a role holding the grant
-- option (a superuser) can restore it: run this script as that role.
DO $$
DECLARE
  target text := current_setting('hyperfide.grant_runtime_role');
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['pg_catalog.pg_control_system()','pg_catalog.pg_control_checkpoint()'] LOOP
    CONTINUE WHEN has_function_privilege(target, fn, 'EXECUTE');
    IF NOT has_function_privilege(current_user, fn, 'EXECUTE WITH GRANT OPTION') THEN
      RAISE EXCEPTION 'Runtime role % lacks EXECUTE on %; rerun grants.sql as a superuser to grant it', target, fn;
    END IF;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, target);
  END LOOP;
END $$;
-- Refuse inherited/PUBLIC migration authority as well as direct grants.
DO $$
DECLARE target text := current_setting('hyperfide.grant_runtime_role');
BEGIN
  IF has_database_privilege(target,current_database(),'CREATE')
    OR has_schema_privilege(target,'hyperfide','CREATE')
    OR has_schema_privilege(target,'public','CREATE')
    OR has_table_privilege(target,'hyperfide.schema_migrations','INSERT,UPDATE,DELETE,TRUNCATE')
  THEN RAISE EXCEPTION 'Runtime role retains migration privileges; operator must remove their source';
  END IF;
  IF NOT (has_function_privilege(target,'pg_catalog.pg_control_system()','EXECUTE')
    AND has_function_privilege(target,'pg_catalog.pg_control_checkpoint()','EXECUTE'))
  THEN RAISE EXCEPTION 'Runtime role lacks pg_control topology observation privileges';
  END IF;
END $$;
COMMIT;
