ALTER TABLE hyperfide.recovery_operations DROP CONSTRAINT recovery_operations_kind_check;
ALTER TABLE hyperfide.recovery_operations ADD CONSTRAINT recovery_operations_kind_check
 CHECK(kind IN ('CONTROL_RECOVER','WORKER_LOSS','STOP','STOP_RECONCILE','RESUME','DRILL','START'));
