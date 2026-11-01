ALTER TABLE hyperfide.fleet_install_heads
 ADD COLUMN sandbox_id uuid,
 ADD COLUMN boot_id uuid,
 ADD COLUMN boot_generation bigint;
UPDATE hyperfide.fleet_install_heads h
 SET sandbox_id=e.sandbox_id,boot_id=e.boot_id,boot_generation=e.boot_generation
 FROM hyperfide.fleet_environment_installs e
 WHERE e.organisation_id=h.organisation_id AND e.run_id=h.run_id AND e.operation_id=h.current_operation_id;
ALTER TABLE hyperfide.fleet_install_heads
 ALTER COLUMN sandbox_id SET NOT NULL,
 ALTER COLUMN boot_id SET NOT NULL,
 ALTER COLUMN boot_generation SET NOT NULL,
 ADD CONSTRAINT fleet_install_head_boot_generation CHECK(boot_generation>0);
ALTER TABLE hyperfide.fleet_environment_installs ADD CONSTRAINT fleet_install_execution_boot
 UNIQUE(organisation_id,run_id,environment_id,environment_generation,sandbox_id,boot_id,boot_generation,operation_id);
ALTER TABLE hyperfide.fleet_install_heads
 DROP CONSTRAINT fleet_install_heads_pkey,
 DROP CONSTRAINT fleet_install_head_environment,
 DROP CONSTRAINT fleet_install_logical_environment,
 ADD PRIMARY KEY(organisation_id,run_id,environment_id,environment_generation,sandbox_id,boot_id,boot_generation),
 ADD CONSTRAINT fleet_install_head_boot
 FOREIGN KEY(organisation_id,run_id,environment_id,environment_generation,sandbox_id,boot_id,boot_generation,current_operation_id)
 REFERENCES hyperfide.fleet_environment_installs(organisation_id,run_id,environment_id,environment_generation,sandbox_id,boot_id,boot_generation,operation_id),
 ADD CONSTRAINT fleet_install_logical_boot
 FOREIGN KEY(organisation_id,run_id,environment_id,environment_generation,sandbox_id,boot_id,boot_generation,logical_operation_id)
 REFERENCES hyperfide.fleet_environment_installs(organisation_id,run_id,environment_id,environment_generation,sandbox_id,boot_id,boot_generation,operation_id);
DROP TRIGGER immutable_binding ON hyperfide.fleet_install_heads;
CREATE TRIGGER immutable_binding BEFORE UPDATE OR DELETE ON hyperfide.fleet_install_heads
 FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','environment_id','environment_generation','sandbox_id','boot_id','boot_generation','logical_operation_id');
