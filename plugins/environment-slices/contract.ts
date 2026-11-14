import { defineRpcContract } from "@hyperfide/plugin-sdk";
import { z } from "zod";
import { NATIVE_SOURCE_ENVIRONMENT_ID } from "@hyperfide/source-control";
export const manifestSchema = z.object({
  kind: z.literal("hyperfide.workspace-slice"),
  mode: z.enum(["SLICE", "FULL_TREE"]),
  fallback_reason: z.string().nullable(),
  digest: z.string().min(1),
  included_paths: z.array(z.string()),
  build_roots: z.array(z.string()),
  metadata_roots: z.array(z.string()),
});
export const sliceInputs = z.object({
  task: z.string().min(1),
  manifest: manifestSchema,
  snapshot: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
const id = z.object({ sliceId: z.string().regex(/^[a-f0-9]{64}$/) });
export const detailSchema = z.object({
  sliceId: z.string(),
  snapshotChain: z.array(z.string()),
  fallbackReason: z.string().nullable(),
});
const nativeRevision = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const nativeGeneration = z.string().regex(/^[1-9][0-9]*$/);
const nativeScope = z.object({
  organisation_id: z.string().uuid(),
  repository_id: z.string().uuid(),
  security_domain_id: z.string().uuid(),
});
export const nativeCheckpointAcknowledgmentSchema = z.object({
  operationId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  workspaceGeneration: nativeGeneration,
  scopeGeneration: nativeGeneration,
  overlayGeneration: nativeGeneration,
  baseRevisionId: nativeRevision,
  result: z.object({
    revision_id: nativeRevision,
    workspace: z
      .object({
        workspace_id: z.string().uuid(),
        workspace_generation: nativeGeneration,
        scope_generation: nativeGeneration,
        authority_epoch: nativeGeneration,
        scope: nativeScope,
        base_revision_id: nativeRevision,
        checkpoint_revision_id: nativeRevision,
      })
      .passthrough(),
    receipt: z
      .object({
        schema_version: z.literal(1),
        operation_id: z.string().uuid(),
        workspace_generation: nativeGeneration,
        overlay_generation: nativeGeneration,
        scope: nativeScope,
      })
      .passthrough(),
  }),
});
export const nativeCheckpointDetailSchema = detailSchema.extend({
  checkpoint: nativeCheckpointAcknowledgmentSchema.nullable(),
});
export const nativeProviderId = NATIVE_SOURCE_ENVIRONMENT_ID;
export const nativeSliceInputs = z.object({
  sourceConfigFile: z.string().startsWith("/"),
  workspaceId: z.string().uuid(),
  mode: z.enum(["SPARSE", "MATERIALIZED", "VIRTUAL"]),
  readPaths: z.array(z.string()).optional(),
});
export const nativeCapabilitiesSchema = z.object({
  profile: z.string(),
  available: z.boolean(),
  reasons: z.array(z.string()),
  fallback: z.object({
    modes: z.array(z.enum(["SPARSE", "MATERIALIZED"])),
    requiresExplicitSelection: z.literal(true),
  }),
});
const measurement = z.number().int().nonnegative();
const filesystemUsage = z.object({
  files: measurement,
  bytes: measurement,
  complete: z.boolean(),
});
export const nativeMetricsSchema = z.object({
  workspace_id: z.string().uuid(),
  mode: z.enum(["SPARSE", "MATERIALIZED", "VIRTUAL"]),
  cache: filesystemUsage.extend({
    counters: z
      .object({
        hits: measurement,
        misses: measurement,
        coalesced: measurement,
        downloads: measurement,
        downloaded_bytes: measurement,
        evictions: measurement,
      })
      .nullable(),
    counter_scope: z.enum(["current_daemon", "persisted_operations"]),
  }),
  materialized: filesystemUsage.nullable(),
  dirty: z.object({
    journal_paths: measurement,
    pending_checkpoint: z.boolean(),
  }),
  virtual: z
    .object({
      metadataRequests: measurement,
      contentHydrations: measurement,
      hydratedBytes: measurement,
      rangeReads: measurement,
      rangeFetchedBytes: measurement,
      requests: measurement,
    })
    .nullable(),
});
const nativeReference = z.object({
  projectId: z.string().min(1).max(256),
  workspaceId: z.string().uuid(),
});
export const slicesHostContract = defineRpcContract({
  create: {
    input: sliceInputs.extend({ repository: z.string(), thread: z.string() }),
    output: z.object({ sliceId: z.string(), path: z.string() }),
  },
  nativeCapabilities: { input: z.object({}), output: nativeCapabilitiesSchema },
  createNative: {
    input: nativeSliceInputs.extend({ thread: z.string() }),
    output: z.object({ sliceId: z.string(), path: z.string() }),
  },
  finishNative: { input: id, output: nativeCheckpointDetailSchema },
  metricsNative: { input: id, output: nativeMetricsSchema },
  detachNative: { input: id, output: detailSchema },
  detailNative: { input: id, output: detailSchema },
  discardNative: { input: id, output: z.object({ removed: z.boolean() }) },
  finish: { input: id, output: detailSchema },
  detail: { input: id, output: detailSchema },
  discard: { input: id, output: z.object({ removed: z.boolean() }) },
});
export const slicesRpcContract = defineRpcContract({
  nativeAttach: {
    input: nativeSliceInputs.extend({
      projectId: z.string().min(1).max(256),
      hostId: z.string().min(1),
    }),
    output: z.object({ sliceId: z.string(), path: z.string() }),
  },
  nativeMetrics: { input: nativeReference, output: nativeMetricsSchema },
  nativeCheckpoint: {
    input: nativeReference,
    output: nativeCheckpointDetailSchema,
  },
  nativeDetach: { input: nativeReference, output: detailSchema },

  nativeCapabilities: {
    input: z.object({ hostId: z.string() }),
    output: nativeCapabilitiesSchema,
  },
  detail: {
    input: z.object({ threadId: z.string() }),
    output: detailSchema.nullable(),
  },
});
