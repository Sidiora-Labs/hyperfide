ALTER TABLE hyperfide.source_git_import_commits
 DROP CONSTRAINT source_git_import_commits_disposition_check,
 ADD CONSTRAINT source_git_import_commits_disposition_check
 CHECK (disposition IN ('IMPORTED', 'COLLAPSED', 'MAPPED'));

ALTER TABLE hyperfide.source_git_contributions
 ADD COLUMN candidate_request jsonb
 CHECK (candidate_request IS NULL OR jsonb_typeof(candidate_request) = 'object');
