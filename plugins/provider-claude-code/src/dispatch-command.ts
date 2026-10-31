export const CLAUDE_RUNNER_KIND = "claude";
export function claudeDispatchCommand(): string {
  return "claude --print --permission-mode bypassPermissions --mcp-config /tmp/hyperfide-mcp.json < /tmp/hyperfide-task.txt";
}
