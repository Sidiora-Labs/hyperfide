import type { Logger } from "@hyperfide/logger";

export type HostDaemonLogger = Pick<
  Logger,
  "debug" | "info" | "warn" | "error"
>;
