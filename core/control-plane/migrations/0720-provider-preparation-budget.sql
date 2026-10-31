-- PREPARATION is an execution budget, independently qualified like other job dimensions.
ALTER TABLE hyperfide.provider_quota_observations DROP CONSTRAINT provider_quota_observations_dimension_check;
ALTER TABLE hyperfide.provider_quota_observations ADD CONSTRAINT provider_quota_observations_dimension_check
 CHECK(dimension IN ('SANDBOX','PROVISIONING','CPU_MILLIS','MEMORY_BYTES','DISK_BYTES','AGENT','BUILD','TEST','INDEX','PREPARATION'));
