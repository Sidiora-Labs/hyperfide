ALTER TABLE hyperfide.source_workspaces
 ADD COLUMN dependency_closure_manifest jsonb NOT NULL DEFAULT
 '{"schema_version":1,"state":"INCOMPLETE","dependencies":[],"reason":"DEPENDENCY_ANALYSIS_UNAVAILABLE"}'::jsonb,
 ADD CONSTRAINT source_workspace_dependency_closure_manifest CHECK (
  dependency_closure_manifest = '{"schema_version":1,"state":"INCOMPLETE","dependencies":[],"reason":"DEPENDENCY_ANALYSIS_UNAVAILABLE"}'::jsonb
 );
