import {
  resolveWorkerMcp,
  type WorkerMcpContext,
} from "@hyperfide/plugin-sdk/provider-bridge";
import { graphWorkerMcp } from "../../hyperfide-graph/src/worker-injection/worker-injection.js";

export function claudeWorkerInjection(context: WorkerMcpContext) {
  const capability = resolveWorkerMcp(context, graphWorkerMcp);
  return {
    attachedCapabilities: capability ? [capability] : [],
    mcpServers: capability?.mcpServers ?? {},
    instructions: capability?.instructions ?? "",
  };
}
