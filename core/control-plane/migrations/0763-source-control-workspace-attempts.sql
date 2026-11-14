ALTER TABLE hyperfide.source_workspaces
 ADD COLUMN attempt_expires_at timestamptz,
 ADD CONSTRAINT source_workspace_attempt_deadline_finite CHECK (
  attempt_expires_at IS NULL OR isfinite(attempt_expires_at)
 );
