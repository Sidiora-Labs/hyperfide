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

/** Modal-only payload. Credentials must never enter the saved server choices. */
export const hyperfideDesktopServerCredentialsSchema = z.object({
  username: z.string().min(1).max(1024).refine(value => !value.includes(":")),
  password: z.string().max(4096),
  remember: z.boolean(),
}).strict();
export type HyperfideDesktopServerCredentials = z.infer<typeof hyperfideDesktopServerCredentialsSchema>;
