ALTER TABLE hyperfide.hierarchy_supervisor_registrations ADD COLUMN gateway_profile jsonb
 CHECK(gateway_profile IS NULL OR jsonb_typeof(gateway_profile)='object' AND octet_length(gateway_profile::text)<=16384);
CREATE TRIGGER immutable_gateway_profile BEFORE UPDATE OR DELETE ON hyperfide.hierarchy_supervisor_registrations
 FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('gateway_profile');
