-- Legacy versions remain unbound until their next authorized rotation.
ALTER TABLE hyperfide.identity_credential_references
 ADD COLUMN source_name hyperfide.name,
 ADD COLUMN secret_digest hyperfide.digest,
 ADD CONSTRAINT identity_credential_source_binding CHECK ((source_name IS NULL) = (secret_digest IS NULL));
