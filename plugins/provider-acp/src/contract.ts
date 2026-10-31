import { defineRpcContract } from "@hyperfide/plugin-sdk";
import { experimental_nativeRootsHostContract } from "@hyperfide/plugin-sdk/host";
import { experimental_acpAgentProbeSchema } from "@hyperfide/plugin-sdk/provider-bridge/acp";
import { z } from "zod";

export const acpHostContract = defineRpcContract({
  probeAgent: {
    input: z
      .object({
        command: z.string().min(1),
        args: z.array(z.string()),
        env: z.record(z.string(), z.string()),
      })
      .strict(),
    output: experimental_acpAgentProbeSchema,
  },
  ...experimental_nativeRootsHostContract,
});
