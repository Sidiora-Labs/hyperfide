import { z } from "zod";

export interface ActiveThinking {
  id: string;
  text: string;
  startedAt: number;
  updatedAt: number;
}

export const activeThinkingSchema = z.object({
  id: z.string(),
  text: z.string(),
  startedAt: z.number(),
  updatedAt: z.number(),
});
