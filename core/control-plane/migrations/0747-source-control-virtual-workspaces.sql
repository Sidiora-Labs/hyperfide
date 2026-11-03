ALTER TABLE hyperfide.source_workspaces
 DROP CONSTRAINT source_workspaces_mode_check,
 ADD CONSTRAINT source_workspaces_mode_check CHECK(mode IN ('API_ONLY','SPARSE','MATERIALIZED','VIRTUAL'));
