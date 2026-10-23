import {
  resolveWorkerMcp,
  graphWorkerMcp,
  type WorkerMcpContext,
} from "@hyperfide/plugin-sdk/provider-bridge";

export function codexWorkerInjection(context: WorkerMcpContext) {
  const capability = resolveWorkerMcp(context, graphWorkerMcp);
  return {
    attachedCapabilities: capability ? [capability] : [],
    config: capability ? { mcp_servers: capability.mcpServers } : {},
    instructions: capability?.instructions ?? "",
  };
}
