import { defineRpcContract } from "@hyperfide/plugin-sdk";
import { z } from "zod";

const id = z.string().uuid();
const revision = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const relative = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.split("/").some((part) => part === ".." || part === ".") &&
      !value.includes("\0"),
    "Use a repository-relative path",
  );
const generation = z.string().regex(/^[1-9][0-9]*$/);
const cursor = z.string().max(32768).optional();
const reference = z
  .object({ id: revision, label: z.string().min(1).max(160) })
  .strict();
export const sourceBindingSchema = z
  .object({
    projectId: z.string().min(1).max(256),
    configFile: z.string().min(1).max(4096),
    hostId: z.string().min(1).max(256).optional(),
    hostConfigFile: z.string().startsWith("/").max(4096).optional(),
    revisions: z.array(reference).max(128).default([]),
    assignments: z
      .array(z.object({ id, label: z.string().min(1).max(160) }).strict())
      .max(128)
      .default([]),
  })
  .strict();
export type SourceBinding = z.infer<typeof sourceBindingSchema>;
export const sourceActionSchema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("service-metrics"),maxRows:z.number().int().min(1).max(4096).optional()}),
  z.object({ kind: z.literal("revision"), revisionId: revision }),
  z.object({ kind: z.literal("history"), revisionId: revision, cursor }),
  z.object({
    kind: z.literal("diff"),
    beforeRevisionId: revision,
    afterRevisionId: revision,
    cursor,
  }),
  z.object({
    kind: z.literal("open"),
    workspaceId: id,
    revisionId: revision,
    readPaths: z.array(relative).min(1).max(128),
    writePaths: z.array(relative).max(128),
    mode: z.enum(["API_ONLY", "SPARSE", "MATERIALIZED", "VIRTUAL"]),
  }),
  z.object({ kind: z.literal("workspace"), workspaceId: id }),
  z.object({ kind: z.literal("file"), revisionId: revision, path: relative }),
  z.object({
    kind: z.literal("checkpoint"),
    workspaceId: id,
    baseRevisionId: revision,
    workspaceGeneration: generation,
    scopeGeneration: generation,
    overlayGeneration: generation,
    path: relative,
    content: z.string().max(65536),
    executable: z.boolean(),
  }),
  z.object({ kind: z.literal("assignment"), assignmentId: id }),
  z.object({
    kind: z.literal("submit"),
    assignmentId: id,
    assignmentGeneration: generation,
    workspaceGeneration: generation,
    revisionId: revision,
  }),
  z.object({
    kind: z.literal("merge"),
    oursRevisionId: revision,
    theirsRevisionId: revision,
    createdAt: z.string().datetime(),
  }),
  z.object({ kind: z.literal("transformation"), transformationId: id }),
  z.object({
    kind: z.literal("resolve-conflict"),
    transformationId: id,
    conflictId: revision,
    resolvedRevisionId: revision,
    expectedGeneration: generation,
  }),
  z.object({ kind: z.literal("candidate"), candidateId: id }),
  z.object({
    kind: z.literal("qualify"),
    candidateId: id,
    evidenceIds: z.array(id).min(1).max(128),
  }),
  z.object({
    kind: z.literal("accept"),
    candidateId: id,
    qualificationId: revision,
  }),
  z.object({
    kind: z.literal("publish"),
    acceptanceId: revision,
    destinationId: z.string().min(1).max(128),
    targetRef: z.string().min(1).max(1024),
    expectedOldOid: z
      .string()
      .regex(/^git:sha1:[a-f0-9]{40}$/)
      .nullable(),
  }),
  z.object({ kind: z.literal("transfer"), transferId: id }),
  z.object({
    kind: z.literal("complete-transfer"),
    transferId: id,
    objectId: revision,
  }),
  z.object({ kind: z.literal("cancel-transfer"), transferId: id }),
  z.object({ kind: z.literal("publication"), publicationId: id }),
  z.object({ kind: z.literal("resume-publication"), publicationId: id }),
  z.object({ kind: z.literal("cancel-publication"), publicationId: id }),
  z.object({ kind: z.literal("operation"), operationId: id }),
  z.object({ kind: z.literal("cancel-operation"), operationId: id }),
]);
export type SourceActionInput = z.infer<typeof sourceActionSchema>;
export const requestSchema = z
  .object({
    projectId: z.string().min(1).max(256),
    operationId: id,
    action: sourceActionSchema,
  })
  .strict();
export type SourceProductRequest = z.infer<typeof requestSchema>;
export const responseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), operationId: id, result: z.unknown() }),
  z.object({
    ok: z.literal(false),
    operationId: id,
    error: z.object({
      code: z.string(),
      message: z.string(),
      retry: z.string(),
      outcome: z.string(),
    }),
  }),
]);
export type SourceProductResponse = z.infer<typeof responseSchema>;
export const hostCapabilitiesSchema = z.object({
  profile: z.string(),
  available: z.boolean(),
  reasons: z.array(z.string()),
  fallback: z.object({
    modes: z.array(z.enum(["SPARSE", "MATERIALIZED"])),
    requiresExplicitSelection: z.literal(true),
  }),
});
export const sourceHostContract = defineRpcContract({
  capabilities: {
    input: z.object({}).strict(),
    output: hostCapabilitiesSchema,
  },
  attach: {
    input: z
      .object({
        sourceConfigFile: z.string().startsWith("/"),
        workspaceId: id,
        mode: z.enum(["SPARSE", "MATERIALIZED", "VIRTUAL"]),
      })
      .strict(),
    output: z.object({ sliceId: z.string(), path: z.string() }),
  },
  metrics: {
    input: z.object({ sliceId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    output: z.unknown(),
  },
  checkpoint: {
    input: z.object({ sliceId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    output: z.object({
      sliceId: z.string(),
      snapshotChain: z.array(z.string()),
      fallbackReason: z.string().nullable(),
    }),
  },
});
export const sourceContract = defineRpcContract({
  hostCapabilities: {
    input: z.object({ projectId: z.string() }),
    output: z.object({
      configured: z.boolean(),
      hostName: z.string().optional(),
      capabilities: hostCapabilitiesSchema.optional(),
    }),
  },
  attach: {
    input: z
      .object({
        projectId: z.string(),
        workspaceId: id,
        mode: z.enum(["SPARSE", "MATERIALIZED", "VIRTUAL"]),
      })
      .strict(),
    output: z.object({ sliceId: z.string(), path: z.string() }),
  },
  hostMetrics: {
    input: z.object({ projectId: z.string(), workspaceId: id }).strict(),
    output: z.unknown(),
  },
  checkpointHost: {
    input: z.object({ projectId: z.string(), workspaceId: id }).strict(),
    output: z.object({
      sliceId: z.string(),
      snapshotChain: z.array(z.string()),
      fallbackReason: z.string().nullable(),
    }),
  },

  projects: {
    input: z.object({}).strict(),
    output: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        configured: z.boolean(),
        revisions: z.array(reference),
        assignments: z.array(z.object({ id, label: z.string() })),
      }),
    ),
  },
  execute: { input: requestSchema, output: responseSchema },
  metrics: { input: z.object({projectId:z.string()}).strict(), output: z.unknown() },
});
