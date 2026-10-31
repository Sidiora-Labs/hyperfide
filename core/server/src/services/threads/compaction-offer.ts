import {
  getExperiments,
  getLatestTokenUsageRow,
  type DbConnection,
} from "@hyperfide/db";
import type { ThreadContextWindowUsage } from "@hyperfide/server-contract";
import type { ProviderRegistryService } from "../providers/provider-registry.js";
import { parseStoredEvent } from "./thread-data.js";

const COMPACTION_OFFER_MIN_TOKENS = 100_000;

interface CompactionOfferDeps {
  db: DbConnection;
  providerRegistry: Pick<ProviderRegistryService, "supportsManualCompaction">;
}

export async function isCompactionOfferEnabled(
  deps: CompactionOfferDeps,
  providerId: string,
): Promise<boolean> {
  return (
    (await getExperiments(deps.db)).compactExpiredCache &&
    deps.providerRegistry.supportsManualCompaction(providerId)
  );
}

interface WithCompactionOfferArgs {
  enabled: boolean;
  sequenceStart: number;
  threadId: string;
  usage: ThreadContextWindowUsage;
}

export async function withCompactionOffer(
  db: DbConnection,
  args: WithCompactionOfferArgs,
): Promise<ThreadContextWindowUsage> {
  if (!args.enabled || args.usage.usedTokens < COMPACTION_OFFER_MIN_TOKENS) {
    return args.usage;
  }
  const row = await getLatestTokenUsageRow(db, {
    sequenceStart: args.sequenceStart,
    threadId: args.threadId,
  });
  if (row === null) return args.usage;
  const event = parseStoredEvent(row);
  if (
    event.type !== "thread/tokenUsage/updated" ||
    event.tokenUsage.promptCacheTtlMs === undefined
  ) {
    return args.usage;
  }
  return {
    ...args.usage,
    compactionOfferAt: new Date(
      row.createdAt + event.tokenUsage.promptCacheTtlMs,
    ).toISOString(),
  };
}
