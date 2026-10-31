import { z } from "zod";

/** JSON-RPC 2.0 messages are sent as individual WebSocket text frames. */
export const LANGUAGE_SERVER_PATH = "/language-server";
export const LANGUAGE_SERVER_STATUS_PATH = "/language-server/status";
export const languageServerQuerySchema = z.object({
  repository: z.string().min(1),
});
export const languageServerStatusSchema = z.object({
  status: z.enum(["running", "stopped"]),
});
export type LanguageServerStatusResponse = z.infer<
  typeof languageServerStatusSchema
>;
export type LanguageServerStatus = LanguageServerStatusResponse["status"];
