import type { Credentials } from "./src/machine-ops.js";
export const SETTING_DESCRIPTORS = {
  HYPERFIDE_RAILWAY_API_TOKEN: {
    type: "string",
    secret: true,
    label: "Railway API token",
    description: "Create an API token in Railway account settings > Tokens.",
  },
  HYPERFIDE_RAILWAY_ENV_ID: {
    type: "string",
    secret: true,
    label: "Railway environment id",
    description:
      "Copy the environment ID from your Railway project environment settings.",
  },
} as const;
export interface RawSettings {
  HYPERFIDE_RAILWAY_API_TOKEN?: string;
  HYPERFIDE_RAILWAY_ENV_ID?: string;
}
export function resolveSettings(raw: RawSettings): Credentials | null {
  const token = raw.HYPERFIDE_RAILWAY_API_TOKEN?.trim();
  const environmentId = raw.HYPERFIDE_RAILWAY_ENV_ID?.trim();
  return token && environmentId ? { token, environmentId } : null;
}
