export type SessionState =
  | { status: "idle" }
  | { status: "authenticating" }
  | { status: "authenticated"; expiresAt: number; restored: boolean }
  | { status: "auth-required"; detail: string }
  | { status: "error"; detail: string; retryAt: number };
