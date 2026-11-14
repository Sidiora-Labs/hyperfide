ALTER TABLE hyperfide.source_revisions
 ADD COLUMN generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0),
 ADD COLUMN index_complete boolean NOT NULL DEFAULT false;

CREATE TABLE hyperfide.source_revision_ancestry (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 revision_id text NOT NULL, position integer NOT NULL CHECK(position>=0 AND position<256),
 ancestor_revision_id text NOT NULL, generation bigint NOT NULL CHECK(generation>=0),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,revision_id,position),
 UNIQUE(organisation_id,repository_id,security_domain_id,revision_id,ancestor_revision_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,revision_id) REFERENCES hyperfide.source_revisions,
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,ancestor_revision_id) REFERENCES hyperfide.source_revisions
);
CREATE INDEX source_ancestry_generation ON hyperfide.source_revision_ancestry
 (organisation_id,repository_id,security_domain_id,revision_id,generation DESC,ancestor_revision_id);
CREATE TRIGGER source_ancestry_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_revision_ancestry
 FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.source_revision_ancestry
 FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
