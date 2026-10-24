import type { ServerLogger, ServerRuntimeConfig } from "../../types.js";
import { runtimeErrorLogFields } from "./error-log-fields.js";

interface DeferAfterResponseArgs {
  config: Pick<ServerRuntimeConfig, "isDevelopment">;
  context?: Record<string, boolean | number | string | null | undefined>;
  logger: Pick<ServerLogger, "warn">;
  name: string;
  work: () => Promise<void>;
}

const pending = new Map<Promise<void>, { config: DeferAfterResponseArgs["config"]; start(): void }>();

export async function whenResponseDeferralsIdle(
  config?: DeferAfterResponseArgs["config"],
): Promise<void> {
  for (;;) {
    const work = [...pending].filter(
      ([, owner]) => !config || owner.config === config,
    );
    if (work.length === 0) return;
    for (const [, owner] of work) owner.start();
    await Promise.all(work.map(([completion]) => completion));
  }
}

export function deferAfterResponse(args: DeferAfterResponseArgs): void {
  let start!: () => void;
  let immediate: ReturnType<typeof setImmediate>;
  const completion = new Promise<void>((resolve) => {
    start = () => { clearImmediate(immediate); resolve(); };
    immediate = setImmediate(start);
  })
    .then(args.work)
    .catch((error) => {
      args.logger.warn(
        {
          ...args.context,
          ...runtimeErrorLogFields(args.config, error),
        },
        `${args.name} failed`,
      );
    })
    .finally(() => pending.delete(completion));
  pending.set(completion, { config: args.config, start });
}
