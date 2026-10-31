import {
  resolveWorkerMcp,
  graphWorkerMcp,
  type WorkerMcpContext,
} from "@hyperfide/plugin-sdk/provider-bridge";

export function claudeWorkerInjection(context: WorkerMcpContext) {
  const capability = resolveWorkerMcp(context, graphWorkerMcp);
  return {
    attachedCapabilities: capability ? [capability] : [],
    mcpServers: capability?.mcpServers ?? {},
    instructions: capability?.instructions ?? "",
  };
}
