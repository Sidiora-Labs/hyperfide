import { z } from "zod";

export const HYPERFIDE_DESKTOP_EXISTING_SERVER_DIALOG_CHOOSE_CHANNEL =
  "hyperfide-desktop:existing-server-dialog:choose";

export const EXISTING_SERVER_DIALOG_CHOICES = [
  "connect",
  "quit",
  "replace",
] as const;

export const existingServerDialogChooseRequestSchema = z
  .object({
    choice: z.enum(EXISTING_SERVER_DIALOG_CHOICES),
  })
  .strict();
export type ExistingServerDialogChooseRequest = z.infer<
  typeof existingServerDialogChooseRequestSchema
>;
