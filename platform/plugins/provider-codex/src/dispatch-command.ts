export const CODEX_RUNNER_KIND = "codex";

export function codexDispatchCommand(quotedMcpConfig: string): string {
  return `codex --ask-for-approval never -c ${quotedMcpConfig} exec --sandbox danger-full-access - < /tmp/hyperfide-task.txt`;
}
