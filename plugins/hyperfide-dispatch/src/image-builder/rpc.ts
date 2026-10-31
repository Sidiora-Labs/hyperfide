import {
  defineRpcContract,
  type HyperfidePluginApi,
} from "@hyperfide/plugin-sdk";
import { z } from "zod";
import { ImageBuilder, type BuildRecord } from "./builder.js";
export const buildRecordSchema: z.ZodType<BuildRecord> = z.object({
  id: z.string(),
  commit: z.string(),
  checkpoint: z.string().nullable(),
  status: z.enum(["running", "succeeded", "failed", "cancelled"]),
  steps: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["running", "succeeded", "failed"]),
      log: z.string(),
      ms: z.number(),
    }),
  ),
  timings: z.object({ started: z.number(), finished: z.number().nullable() }),
  error: z.string().optional(),
});
export const imageBuilderContract = defineRpcContract({
  imageBuildConfiguration: {
    input: z.null(),
    output: z.object({ configured: z.boolean(), message: z.string() }),
  },
  imageBuilds: { input: z.null(), output: z.array(buildRecordSchema) },
  imageBuildStart: {
    input: z.object({ commit: z.string().trim().min(1).max(256) }),
    output: buildRecordSchema,
  },
  imageBuildCancel: { input: z.object({ id: z.string() }), output: z.null() },
});
export function registerImageBuilder(
  api: Pick<HyperfidePluginApi, "rpc">,
  builder: ImageBuilder,
) {
  api.rpc.register(
    imageBuilderContract,
    {
      imageBuildConfiguration: async () => ({
        configured: true,
        message: "Ready",
      }),
      imageBuilds: async () => builder.list(),
      imageBuildStart: async ({ commit }) => builder.start(commit),
      imageBuildCancel: async ({ id }) => {
        await builder.cancel(id);
        return null;
      },
    },
    {
      experimental_discoverable: true,
      experimental_description: "Build fleet images",
    },
  );
}
