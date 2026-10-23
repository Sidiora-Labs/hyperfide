import { z } from "zod";

export const hyperfideDesktopServerChoiceSchema = z
  .object({
    id: z.string().min(1).max(256),
    name: z.string().min(1),
    active: z.boolean(),
  })
  .strict();
export const hyperfideDesktopServerChoicesSchema = z.array(
  hyperfideDesktopServerChoiceSchema,
);
export type HyperfideDesktopServerChoice = z.infer<typeof hyperfideDesktopServerChoiceSchema>;
