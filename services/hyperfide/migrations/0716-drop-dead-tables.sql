-- Drop five tables nothing reads or writes (hyperfide-v21 7.10, req 7.3).
--
-- How each was proved unused. Searched at main 1946b4d8 with ripgrep, whole word, over
-- services/hyperfide/src services/hyperfide/components tests scripts src deploy editors,
-- excluding dist, node_modules and tests/hyperfide/manifests:
--   rg -nw <table> services tests scripts src deploy editors
-- plus the singular and camelCase forms (rg -n 'resource_cleanup_receipt|runner_command_receipt|
-- preparation_reference|branch_observation|review_coverage_input|cleanupReceipt|commandReceipt|
-- branchObservation|coverageInput'); the singular preparation_reference hits are the provider
-- 'prepare' parameter, not this table.
--   resource_cleanup_receipts (0005)  only its own CREATE TABLE and triggers in 0005.
--   runner_command_receipts (0012)    only its own CREATE TABLE and trigger in 0012.
--   preparation_references (0001)     its 0001 DDL, the AUTHORITY_TABLES inventory in
--   branch_observations (0001)        storage/schema.ts and the matching expected set in
--   review_coverage_inputs (0001)     tests/hyperfide/cases/tasks/4_1.py; no SELECT, INSERT,
--                                     UPDATE, DELETE or COPY anywhere. Both lists drop them here.
-- No foreign key, view or function body names any of the five (rg over migrations), so each
-- DROP is plain, without CASCADE: a dependency added later fails this migration instead of
-- being dropped with it. Their triggers go with the tables.
--
-- Kept, though the programme inventory (ops-infra.md section 6) listed it as a sixth:
-- candidate_evidence still has a reader, artifacts/retention.ts PENDING_PUBLICATION_EVIDENCE,
-- and the 0029 artifact-availability trigger and retention functions select from it.
DROP TABLE hyperfide.resource_cleanup_receipts;
DROP TABLE hyperfide.runner_command_receipts;
DROP TABLE hyperfide.preparation_references;
DROP TABLE hyperfide.branch_observations;
DROP TABLE hyperfide.review_coverage_inputs;
