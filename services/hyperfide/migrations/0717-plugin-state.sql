-- Plugin observations are scoped to the authenticated organisation and run.
CREATE TABLE hyperfide.plugin_state (
 organisation_id uuid NOT NULL,
 run_id uuid NOT NULL,
 plugin text NOT NULL CHECK(plugin IN ('hyperfide-spec','hyperfide-asks','hyperfide-qualify','hyperfide-dispatch')),
 scope text NOT NULL CHECK(length(scope) BETWEEN 1 AND 2048),
 key text NOT NULL CHECK(length(key) BETWEEN 1 AND 2048),
 value jsonb NOT NULL CHECK(octet_length(value::text)<=262144),
 PRIMARY KEY(organisation_id,run_id,plugin,scope,key)
);
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.plugin_state FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
