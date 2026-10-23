import { defineRpcContract, type HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import { z } from "zod";
import { ImageBuilder, type BuildRecord } from "./builder.js";
export const imageBuilderContract = defineRpcContract({
  imageBuilds: { input: z.null(), output: z.array(z.custom<BuildRecord>()) },
  imageBuildStart: {
    input: z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/) }),
    output: z.custom<BuildRecord>(),
  },
  imageBuildCancel: { input: z.object({ id: z.string() }), output: z.null() },
});
export function registerImageBuilder(
  api: Pick<HyperfidePluginApi, "rpc">,
  builder: ImageBuilder,
) {
  api.rpc.register(imageBuilderContract, {
    imageBuilds: async () => builder.list(),
    imageBuildStart: async ({ commit }) => builder.start(commit),
    imageBuildCancel: async ({ id }) => {
      await builder.cancel(id);
      return null;
    },
  });
}
