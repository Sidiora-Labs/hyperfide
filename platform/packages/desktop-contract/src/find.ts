import { z } from "zod";

export const HYPERFIDE_DESKTOP_MAX_FIND_TEXT_LENGTH = 1024;
export const HYPERFIDE_DESKTOP_MAX_FIND_TOP_OFFSET = 400;

export const bbDesktopWindowFindRequestSchema = z
  .object({
    topOffset: z
      .number()
      .int()
      .min(0)
      .max(HYPERFIDE_DESKTOP_MAX_FIND_TOP_OFFSET),
  })
  .strict();
export type BbDesktopWindowFindRequest = z.infer<
  typeof bbDesktopWindowFindRequestSchema
>;
