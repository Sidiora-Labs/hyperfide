import {
  parseGeneration,
  parseObjectId,
  parseUUID,
  type SourceScope,
} from "./contracts.js";
import {
  SourceMetadata,
  sourceDigest,
  sourceFailure,
  sourceScopeValues,
  type SourceContext,
  type SourceSQL,
} from "./metadata.js";
import { SourceAcceptanceService } from "./acceptance.js";
import { assertPrimaryTransaction } from "../storage/transactions.js";
import {
  assertInvocation,
  type InvocationContext,
} from "../transport/protocol.js";
import { requireAuthority } from "../hierarchy/packages.js";
import { recordSourceEvent } from "./candidates.js";
import { assertNativeTaskQualified } from "../assurance/fleet_native.js";

export interface FleetSourceSelectionInput {
  operation_id: string;
  idempotency_key: string;
  selection_id: string;
  run_id: string;
  acceptance_id: string;
  expected_generation: string;
  leader_generation: string;
}
export interface NativeFleetSelection {
  schema_version: 1;
  scope: SourceScope;
  selection_id: string;
  run_id: string;
  generation: string;
  previous_revision_id: string;
  revision_id: string;
  root_tree_id: string;
  acceptance_id: string;
  acceptance_digest: string;
  run_authority_epoch: string;
  source_authority_epoch: string;
  result_digest: string;
}

async function descendant(
  tx: SourceSQL,
  scope: SourceScope,
  revision: string,
  ancestor: string,
): Promise<void> {
  const visited = new Set<string>(),
    deadline = performance.now() + 5000;
  let pending = [revision];
  while (pending.length) {
    if (performance.now() > deadline || visited.size + pending.length > 4096)
      sourceFailure(
        "LIMIT_EXCEEDED",
        "Native source selection ancestry exceeds its bounded work budget",
      );
    const frontier = pending.splice(0, 128).filter((id) => !visited.has(id));
    if (frontier.includes(ancestor)) return;
    frontier.forEach((id) => visited.add(id));
    if (!frontier.length) continue;
    const parents = await tx.query<{ parent_revision_id: string }>(
      "SELECT DISTINCT parent_revision_id FROM hyperfide.source_revision_parents WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND revision_id=ANY($4::text[])",
      [...sourceScopeValues(scope), frontier],
    );
    for (const row of parents.rows) {
      if (row.parent_revision_id === ancestor) return;
      if (
        !visited.has(row.parent_revision_id) &&
        !pending.includes(row.parent_revision_id)
      )
        pending.push(row.parent_revision_id);
    }
  }
  sourceFailure(
    "FLEET_SOURCE_DIVERGED",
    "Selected accepted source must descend from the previous native run selection",
  );
}

export class SourceFleetSelectionService {
  constructor(
    readonly metadata: SourceMetadata,
    readonly acceptance: SourceAcceptanceService,
  ) {}
  async select(
    context: SourceContext,
    input: FleetSourceSelectionInput,
    invocation?: InvocationContext,
  ): Promise<NativeFleetSelection> {
    const keys = [
      "operation_id",
      "idempotency_key",
      "selection_id",
      "run_id",
      "acceptance_id",
      "expected_generation",
      "leader_generation",
    ];
    if (
      !input ||
      typeof input !== "object" ||
      Object.keys(input).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(input, key))
    )
      sourceFailure(
        "INVALID_REQUEST",
        "Native selection fields differ from the versioned contract",
      );
    parseUUID(input.selection_id);
    parseUUID(input.run_id);
    parseObjectId(input.acceptance_id);
    parseGeneration(input.expected_generation);
    parseGeneration(input.leader_generation);
    assertInvocation(invocation);
    if (
      invocation.principal.actor_id !== context.principal_id ||
      invocation.principal.organisation_id !== context.scope.organisation_id ||
      invocation.principal.run_id !== input.run_id
    )
      sourceFailure(
        "FLEET_PRINCIPAL_MISMATCH",
        "Native source selection requires its authenticated run leader",
      );
    return this.acceptance.candidates.mutate(
      context,
      "source.fleet.select",
      input,
      async (tx) => {
        assertPrimaryTransaction(tx);
        await invocation.guard(tx);
        await requireAuthority(tx, {
          organisation_id: context.scope.organisation_id,
          run_id: input.run_id,
          session_id: context.principal_id,
          authority_epoch: invocation.principal.deployment_epoch,
          leader_generation: input.leader_generation,
          roles: ["LEADER"],
        });
        const scope = [...sourceScopeValues(context.scope), input.run_id];
        const baseline = (
          await tx.query(
            "SELECT * FROM hyperfide.source_fleet_runs WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND run_id=$4 FOR UPDATE",
            scope,
          )
        ).rows[0];
        if (
          !baseline ||
          baseline.authority_epoch !== invocation.principal.deployment_epoch ||
          String(baseline.source_authority_epoch) !== context.authority_epoch
        )
          sourceFailure(
            "FLEET_SOURCE_STALE",
            "Native run baseline no longer belongs to the current authority",
          );
        await tx.query(
          "INSERT INTO hyperfide.source_fleet_selection_heads(organisation_id,repository_id,security_domain_id,run_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          scope,
        );
        const head = (
          await tx.query(
            "SELECT h.generation::text,h.selection_id,s.revision_id FROM hyperfide.source_fleet_selection_heads h LEFT JOIN hyperfide.source_fleet_selections s USING(organisation_id,repository_id,security_domain_id,run_id,selection_id) WHERE h.organisation_id=$1 AND h.repository_id=$2 AND h.security_domain_id=$3 AND h.run_id=$4 FOR UPDATE OF h",
            scope,
          )
        ).rows[0]!;
        if (head.generation !== input.expected_generation)
          sourceFailure(
            "FLEET_SOURCE_CHANGED",
            "Native source selection generation changed",
          );
        const authorityContext: SourceContext = {
          ...context,
          ...(context.assertCurrent
            ? {
                assertCurrent: (sql: SourceSQL, action?: string) =>
                  context.assertCurrent!(
                    sql,
                    action === "source.acceptance.read"
                      ? "source.fleet.select"
                      : action,
                  ),
              }
            : {}),
        };
        const accepted = await this.acceptance.authorizeAcceptance(
          tx,
          authorityContext,
          input.acceptance_id,
        );
        const candidate =
          await this.acceptance.candidates.candidateInTransaction(
            tx,
            authorityContext,
            accepted.candidate_id,
          );
        let predecessors = 0;
        for (const contributor of candidate.contributors) {
          if (!contributor.run_id || !contributor.task_id) continue;
          const qualified = await assertNativeTaskQualified(
            tx,
            {
              organisation_id: context.scope.organisation_id,
              run_id: contributor.run_id,
            },
            contributor.task_id,
            context.scope.repository_id,
          );
          if (
            qualified.custody_id !== contributor.custody_id ||
            qualified.custody_generation !== contributor.custody_generation ||
            qualified.revision_id !== contributor.revision_id ||
            qualified.scope.security_domain_id !==
              context.scope.security_domain_id
          )
            sourceFailure(
              "FLEET_PREDECESSOR_UNQUALIFIED",
              "Accepted source contributor has no current Hyperfide task qualification",
            );
          if (contributor.run_id === input.run_id) predecessors++;
        }
        if (!predecessors)
          sourceFailure(
            "FLEET_PREDECESSOR_REQUIRED",
            "Source advancement requires a qualified predecessor from this run",
          );
        const previous = head.revision_id ?? baseline.revision_id;
        if (accepted.revision_id === previous)
          sourceFailure(
            "FLEET_SOURCE_UNCHANGED",
            "Native source selection already uses this accepted revision",
          );
        await descendant(tx, context.scope, accepted.revision_id, previous);
        const generation = (BigInt(head.generation) + 1n).toString();
        if (BigInt(generation) > 9223372036854775807n)
          sourceFailure(
            "LIMIT_EXCEEDED",
            "Native source selection generation is exhausted",
          );
        const body = {
          schema_version: 1 as const,
          scope: context.scope,
          selection_id: input.selection_id,
          run_id: input.run_id,
          generation,
          previous_revision_id: previous,
          revision_id: accepted.revision_id,
          root_tree_id: accepted.root_tree_id,
          acceptance_id: accepted.acceptance_id,
          acceptance_digest: accepted.result_digest,
          run_authority_epoch: invocation.principal.deployment_epoch,
          source_authority_epoch: context.authority_epoch,
        };
        const receipt: NativeFleetSelection = {
          ...body,
          result_digest: sourceDigest(body),
        };
        await this.metadata.protectRoot(
          tx,
          context.scope,
          accepted.root_tree_id,
          "native-fleet-selection:" + input.selection_id,
        );
        await tx.query(
          "INSERT INTO hyperfide.source_fleet_selections(organisation_id,repository_id,security_domain_id,run_id,selection_id,generation,previous_revision_id,revision_id,root_tree_id,acceptance_id,acceptance_digest,run_authority_epoch,source_authority_epoch,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
          [
            ...scope,
            input.selection_id,
            generation,
            previous,
            accepted.revision_id,
            accepted.root_tree_id,
            accepted.acceptance_id,
            accepted.result_digest,
            invocation.principal.deployment_epoch,
            context.authority_epoch,
            receipt,
          ],
        );
        const advanced = await tx.query(
          "UPDATE hyperfide.source_fleet_selection_heads SET generation=$5,selection_id=$6 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND run_id=$4 AND generation=$7",
          [...scope, generation, input.selection_id, head.generation],
        );
        if (advanced.rowCount !== 1)
          sourceFailure(
            "FLEET_SOURCE_CHANGED",
            "Native source selection changed before commit",
          );
        await recordSourceEvent(
          tx,
          context,
          "fleet-source:" + input.run_id,
          generation,
          "NATIVE_FLEET_SOURCE_SELECTED",
          receipt,
        );
        return receipt;
      },
    );
  }
  async read(
    context: SourceContext,
    input: { run_id: string; selection_id: string },
  ): Promise<NativeFleetSelection> {
    return this.metadata.transaction(async (tx) => {
      await this.metadata.guard(tx, context, "source.fleet.selection");
      const row = (
        await tx.query(
          "SELECT receipt FROM hyperfide.source_fleet_selections WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND run_id=$4 AND selection_id=$5",
          [
            ...sourceScopeValues(context.scope),
            parseUUID(input.run_id),
            parseUUID(input.selection_id),
          ],
        )
      ).rows[0];
      if (!row)
        sourceFailure("NOT_FOUND", "Native source selection is unavailable");
      return row.receipt;
    });
  }
}
