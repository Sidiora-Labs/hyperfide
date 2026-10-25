import { hyperfideDesktopServerCredentialsSchema, type HyperfideDesktopServerCredentials } from "@hyperfide/desktop-contract";
export const CREDENTIALS_SUBMIT = "hyperfide-desktop:credentials:submit";
export const CREDENTIALS_CANCEL = "hyperfide-desktop:credentials:cancel";
export const credentialsRequestSchema = hyperfideDesktopServerCredentialsSchema;
export type CredentialsRequest = HyperfideDesktopServerCredentials;
