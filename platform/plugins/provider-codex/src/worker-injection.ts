import {
  resolveWorkerMcp,
  type WorkerMcpContext,
} from "@hyperfide/plugin-sdk/provider-bridge";
import { graphWorkerMcp } from "../../hyperfide-graph/src/worker-injection/worker-injection.js";

export function codexWorkerInjection(context: WorkerMcpContext) {
  const capability = resolveWorkerMcp(context, graphWorkerMcp);
  return {
    attachedCapabilities: capability ? [capability] : [],
    config: capability ? { mcp_servers: capability.mcpServers } : {},
    instructions: capability?.instructions ?? "",
  };
}
