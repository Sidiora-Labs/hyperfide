import { defineRpcContract } from "@hyperfide/plugin-sdk";
import { z } from "zod";

export const echoProviderHostContract = defineRpcContract({
  hostGreeting: {
    input: z.object({}).strict(),
    output: z.object({ platform: z.string(), dataDir: z.string() }).strict(),
  },
});
