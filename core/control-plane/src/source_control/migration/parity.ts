import { createHash } from "node:crypto";
import { canonicalBytes, SourceControlError } from "../contracts.js";
import { sourcePathWithin } from "../capabilities.js";
import {
  sourceDigest,
  sourceScopeValues,
  type SourceContext,
  type SourceMetadata,
} from "../metadata.js";
import type { SourceObjectService } from "../objects.js";
import type { PersistentTree } from "../trees.js";
import {
  decodeGitTreeEntries,
  decodeImportedCommit,
  decodeGitMetadata,
} from "../git/import.js";
import type { GitImportSource } from "../git/import_transport.js";
import { SourceGitProvenance } from "../git/provenance.js";
import type { ConsolidationManifest } from "./consolidation.js";
type Entry = { path: string; mode: string; digest: string };
export interface NativeParityReceipt {
  schema_version: 1;
  manifest_digest: string;
  revision_id: string;
  projects: {
    project_id: string;
    source_digest: string;
    native_digest: string;
    files: number;
    access_digest: string;
    evidence_digest: string;
    retained_evidence: number;
  }[];
  access_digest: string;
  evidence_digest: string;
  state: "MATCHED";
  receipt_digest: string;
}
export async function compareNativeMigration(
  metadata: SourceMetadata,
  objects: SourceObjectService,
  trees: PersistentTree,
  sources: readonly GitImportSource[],
  context: SourceContext,
  manifest: ConsolidationManifest,
  revisionId: string,
): Promise<NativeParityReceipt> {
  const revision = await metadata.readRevision(context, revisionId),
    projects: NativeParityReceipt["projects"] = [],
    expectedProjects: Entry[] = [];
  let reads = 0,
    bytes = 0;
  const check = () => {
    if (++reads > 200000 || bytes > 268435456)
      throw new SourceControlError(
        "PARITY_LIMIT",
        "Complete selected parity exceeds its bounded inventory",
      );
  };
  const hash = (data: Uint8Array) =>
    "sha256:" + createHash("sha256").update(data).digest("hex");
  for (const project of manifest.projects) {
    const source = sources.find(
      (s) =>
        s.id === project.source_id &&
        sourceDigest(s.scope) === sourceDigest(context.scope),
    );
    if (!source)
      throw new SourceControlError(
        "SOURCE_IMPORT_DENIED",
        "Parity source is not configured",
      );
    if (
      !source.resolve ||
      (await source.resolve(project.source_ref)) !== project.tip_oid
    )
      throw new SourceControlError(
        "MIGRATION_SOURCE_CHANGED",
        "Configured source ref differs from the pinned tip",
      );
    const imported = await metadata.transaction(async (tx) => {
      await metadata.guard(tx, context, "source.migration.parity");
      return (
        await tx.query(
          "SELECT * FROM hyperfide.source_git_imports WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND import_id=$4",
          [...sourceScopeValues(context.scope), project.import_id],
        )
      ).rows[0];
    });
    if (
      !imported ||
      imported.state !== "COMPLETE" ||
      imported.tip_oid !== project.tip_oid
    )
      throw new SourceControlError(
        "PARITY_IMPORT_CHANGED",
        "Complete pinned import required",
      );
    const policy = (
      await new SourceGitProvenance(metadata).readPolicy(
        context,
        imported.policy_id,
        imported.policy_version,
      )
    ).policy;
    const read = async (oid: string) => {
      check();
      const object = await source.read(oid, 67108864);
      bytes += object.payload.length;
      check();
      return object;
    };
    let tip = await read(project.tip_oid);
    if (tip.kind === "tag")
      tip = await read(
        "git:sha1:" + decodeGitMetadata(tip).fields.get("object")![0],
      );
    const commit = decodeImportedCommit(tip, policy),
      expected: Entry[] = [],
      actual: Entry[] = [];
    const gitWalk = async (
      oid: string,
      target: string,
      depth: number,
    ): Promise<void> => {
      if (depth > 256)
        throw new SourceControlError(
          "PARITY_LIMIT",
          "Git tree depth exceeds limit",
        );
      const object = await read(oid);
      if (object.kind !== "tree")
        throw new SourceControlError(
          "PARITY_GIT_TREE",
          "Expected a source tree",
        );
      for (const item of decodeGitTreeEntries(object.payload)) {
        const name = target ? target + "/" + item.name : item.name;
        if (["040000", "40000"].includes(item.mode)) {
          await gitWalk(item.oid, name, depth + 1);
          continue;
        }
        if (!["100644", "100755", "120000"].includes(item.mode))
          throw new SourceControlError(
            "PARITY_ENTRY_UNSUPPORTED",
            "Selected entry cannot be compared",
          );
        const file = await read(item.oid);
        if (file.kind !== "blob")
          throw new SourceControlError(
            "PARITY_GIT_TREE",
            "Expected blob content",
          );
        expected.push({
          path: name,
          mode: item.mode,
          digest: hash(file.payload),
        });
      }
    };
    const nativeWalk = async (
      root: string,
      target: string,
      depth: number,
    ): Promise<void> => {
      if (depth > 256)
        throw new SourceControlError(
          "PARITY_LIMIT",
          "Native tree depth exceeds limit",
        );
      let cursor: string | undefined;
      do {
        check();
        const page = await trees.list(context.scope, root, {
          limit: 256,
          ...(cursor ? { cursor } : {}),
        });
        for (const item of page.entries) {
          const name = target ? target + "/" + item.name : item.name;
          if (item.kind === "directory") {
            await nativeWalk(item.object_id, name, depth + 1);
            continue;
          }
          const data =
            item.kind === "symlink"
              ? (await objects.read(context.scope, item.object_id)).payload
              : await objects.readFile(context.scope, item.object_id);
          bytes += data.length;
          check();
          actual.push({ path: name, mode: item.mode, digest: hash(data) });
        }
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
    };
    for (const mapping of policy.mappings) {
      if (
        mapping.target_path !== project.target_path &&
        !mapping.target_path.startsWith(project.target_path + "/")
      )
        throw new SourceControlError(
          "PARITY_POLICY_SCOPE",
          "Projection mapping escapes its declared project",
        );
      let sourceRoot = commit.tree;
      for (const name of mapping.source_path
        ? mapping.source_path.split("/")
        : []) {
        const object = await read(sourceRoot);
        const selected = decodeGitTreeEntries(object.payload).find(
          (entry) => entry.name === name,
        );
        if (!selected || !["40000", "040000"].includes(selected.mode))
          throw new SourceControlError(
            "PARITY_GIT_TREE",
            "Mapped source root unavailable",
          );
        sourceRoot = selected.oid;
      }
      await gitWalk(sourceRoot, mapping.target_path, 0);
      const nativeRoot = await trees.lookup(
        context.scope,
        revision.root_tree_id,
        mapping.target_path,
      );
      if (!nativeRoot || nativeRoot.kind !== "directory")
        throw new SourceControlError(
          "PARITY_NATIVE_TREE",
          "Mapped native root unavailable",
        );
      await nativeWalk(nativeRoot.object_id, mapping.target_path, 0);
    }
    const sort = (a: Entry, b: Entry) =>
      Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));
    expected.sort(sort);
    actual.sort(sort);
    const source_digest = sourceDigest(expected),
      native_digest = sourceDigest(actual);
    if (source_digest !== native_digest)
      throw new SourceControlError(
        "PARITY_MISMATCH",
        "Complete selected source content/type/mode differs",
      );
    const mappings = await metadata.transaction(
      async (tx) =>
        (
          await tx.query(
            "SELECT git_oid,revision_id,ordered_parent_oids,disposition FROM hyperfide.source_git_import_commits WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND import_id=$4 LIMIT 10001",
            [...sourceScopeValues(context.scope), project.import_id],
          )
        ).rows,
    );
    if (mappings.length > 10000)
      throw new SourceControlError(
        "PARITY_LIMIT",
        "Ancestry parity requires a narrower selected history",
      );
    const byGit = new Map(mappings.map((m) => [m.git_oid, m]));
    for (const mapping of mappings) {
      const record = await metadata.readRevision(context, mapping.revision_id);
      if (mapping.disposition === "COLLAPSED") continue;
      const parents = [
        ...new Set(
          (mapping.ordered_parent_oids as string[]).map(
            (id) => byGit.get(id)?.revision_id,
          ),
        ),
      ];
      if (parents.some((p) => !p))
        throw new SourceControlError(
          "PARITY_ANCESTRY",
          "Import parent map is incomplete",
        );
      if (!parents.length) parents.push(imported.base_revision_id);
      if (sourceDigest(parents) !== sourceDigest(record.parent_revision_ids))
        throw new SourceControlError(
          "PARITY_ANCESTRY",
          "Native parent order differs from the source map",
        );
    }
    const access = await metadata.transaction(async (tx) => {
      await metadata.guard(tx, context, "source.migration.parity");
      if (!context.capability_id)
        throw new SourceControlError(
          "PARITY_ACCESS_MISMATCH",
          "Parity requires an explicit current native capability",
        );
      const capability = (
        await tx.query(
          "SELECT path_prefixes,actions FROM hyperfide.source_capabilities WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND id=$4 AND principal_id=$5 AND authority_epoch=$6 AND policy_version=$7 AND revoked_at IS NULL AND expires_at>clock_timestamp()",
          [
            ...sourceScopeValues(context.scope),
            context.capability_id,
            context.principal_id,
            context.authority_epoch,
            context.policy_version,
          ],
        )
      ).rows[0];
      const grants = policy.mappings
        .map((mapping) => ({
          source_path: mapping.source_path,
          target_path: mapping.target_path,
          read: true,
          write: true,
        }))
        .sort((a, b) => a.target_path.localeCompare(b.target_path));
      if (
        !capability ||
        ![
          "source.objects.read",
          "source.revisions.read",
          "source.revisions.create",
        ].every((action) => capability.actions.includes(action)) ||
        grants.some(
          (grant) =>
            !sourcePathWithin(grant.target_path, capability.path_prefixes),
        )
      )
        throw new SourceControlError(
          "PARITY_ACCESS_MISMATCH",
          "Projection path grants exceed current native read/write capabilities",
        );
      for (const dependency of policy.dependencies)
        if (dependency.treatment === "EXTERNAL_PIN") {
          const pin = await metadata.readRevisionInTransaction(
            tx,
            context,
            dependency.revision_id!,
          );
          if (!pin)
            throw new SourceControlError(
              "PARITY_ACCESS_MISMATCH",
              "External dependency binding unavailable",
            );
        }
      const native = grants.map((grant) => ({
        ...grant,
        read: capability.actions.includes("source.objects.read"),
        write: capability.actions.includes("source.revisions.create"),
      }));
      if (sourceDigest(grants) !== sourceDigest(native))
        throw new SourceControlError(
          "PARITY_ACCESS_MISMATCH",
          "Native and projected grants differ",
        );
      return { policy_digest: sourceDigest(policy), grants, native };
    });
    const evidence = await metadata.transaction(async (tx) => {
      await metadata.guard(tx, context, "source.migration.parity");
      const rows = (
        await tx.query(
          "SELECT e.*,c.revision_id,c.root_tree_id,c.manifest_digest AS candidate_manifest_digest FROM hyperfide.source_native_assurance_evidence e JOIN hyperfide.source_native_candidates c USING(organisation_id,repository_id,security_domain_id,candidate_id) WHERE e.organisation_id=$1 AND e.repository_id=$2 AND e.security_domain_id=$3 AND EXISTS(SELECT 1 FROM hyperfide.source_git_import_commits m WHERE m.organisation_id=c.organisation_id AND m.repository_id=c.repository_id AND m.security_domain_id=c.security_domain_id AND m.import_id=$4 AND m.revision_id=c.revision_id) ORDER BY e.evidence_id LIMIT 10001",
          [...sourceScopeValues(context.scope), project.import_id],
        )
      ).rows;
      if (rows.length > 10000)
        throw new SourceControlError(
          "PARITY_LIMIT",
          "Retained evidence exceeds parity inventory",
        );
      return rows;
    });
    const retained = [];
    for (const binding of evidence) {
      const object = await objects.read(
        context.scope,
        binding.receipt_object_id,
      );
      bytes += object.payload.length;
      check();
      const receipt = binding.receipt;
      if (
        object.kind !== "blob" ||
        !Buffer.from(object.payload).equals(canonicalBytes(receipt)) ||
        sourceDigest(receipt) !== binding.receipt_digest ||
        receipt.candidate_id !== binding.candidate_id ||
        receipt.candidate_manifest_digest !== binding.manifest_digest ||
        binding.manifest_digest !== binding.candidate_manifest_digest ||
        receipt.revision_id !== binding.revision_id ||
        receipt.root_tree_id !== binding.root_tree_id ||
        receipt.check_id !== binding.check_id ||
        receipt.execution.execution_id !== binding.execution_id
      )
        throw new SourceControlError(
          "PARITY_EVIDENCE_MISMATCH",
          "Retained receipt and native evidence source bindings differ",
        );
      retained.push({
        evidence_id: binding.evidence_id,
        candidate_id: binding.candidate_id,
        revision_id: binding.revision_id,
        root_tree_id: binding.root_tree_id,
        manifest_digest: binding.manifest_digest,
        policy_id: binding.policy_id,
        policy_digest: binding.policy_digest,
        receipt_digest: binding.receipt_digest,
        receipt_object_id: binding.receipt_object_id,
        outcome: binding.outcome,
        revoked_at: binding.revoked_at
          ? new Date(binding.revoked_at).toISOString()
          : null,
      });
    }
    expectedProjects.push(...expected);
    projects.push({
      project_id: project.project_id,
      source_digest,
      native_digest,
      files: expected.length,
      access_digest: sourceDigest(access),
      evidence_digest: sourceDigest(retained),
      retained_evidence: retained.length,
    });
  }
  const flatten = async (
    root: string,
    prefix: string,
    output: Entry[],
    depth = 0,
  ): Promise<void> => {
    if (depth > 256)
      throw new SourceControlError(
        "PARITY_LIMIT",
        "Complete tree exceeds depth bound",
      );
    let cursor: string | undefined;
    do {
      check();
      const page = await trees.list(context.scope, root, {
        limit: 256,
        ...(cursor ? { cursor } : {}),
      });
      for (const entry of page.entries) {
        const name = prefix ? prefix + "/" + entry.name : entry.name;
        if (entry.kind === "directory")
          await flatten(entry.object_id, name, output, depth + 1);
        else {
          const data =
            entry.kind === "symlink"
              ? (await objects.read(context.scope, entry.object_id)).payload
              : await objects.readFile(context.scope, entry.object_id);
          bytes += data.length;
          check();
          output.push({ path: name, mode: entry.mode, digest: hash(data) });
        }
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  };
  const baseline = await metadata.readRevision(
      context,
      manifest.base_revision_id,
    ),
    expectedComplete: Entry[] = [],
    actualComplete: Entry[] = [];
  await flatten(baseline.root_tree_id, "", expectedComplete);
  expectedComplete.push(...expectedProjects);
  await flatten(revision.root_tree_id, "", actualComplete);
  const order = (a: Entry, b: Entry) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));
  expectedComplete.sort(order);
  actualComplete.sort(order);
  if (sourceDigest(expectedComplete) !== sourceDigest(actualComplete))
    throw new SourceControlError(
      "PARITY_MISMATCH",
      "Consolidated tree contains missing or unexpected baseline/project content",
    );
  const receipt = {
    schema_version: 1 as const,
    manifest_digest: sourceDigest(manifest),
    revision_id: revisionId,
    projects,
    access_digest: sourceDigest(
      projects.map((p) => ({
        project_id: p.project_id,
        digest: p.access_digest,
      })),
    ),
    evidence_digest: sourceDigest(
      projects.map((p) => ({
        project_id: p.project_id,
        digest: p.evidence_digest,
      })),
    ),
    state: "MATCHED" as const,
  };
  return { ...receipt, receipt_digest: sourceDigest(receipt) };
}
