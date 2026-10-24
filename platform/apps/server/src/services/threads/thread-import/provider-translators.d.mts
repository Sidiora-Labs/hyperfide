import type { ThreadDelta } from "@hyperfide/plugin-sdk/provider-bridge";
interface TranscriptTranslator {
  translate(record: Record<string, unknown>): ThreadDelta[];
  settle(): ThreadDelta[];
}
export function createClaudeTranscriptTranslator(options: {
  cwd: string;
  threadId: string;
}): TranscriptTranslator;
export function createCodexTranscriptTranslator(options: {
  threadId: string;
}): TranscriptTranslator;
