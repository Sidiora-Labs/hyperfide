import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import {
  resolveWorkflowSource,
  type ResolvedWorkflowSource,
  type WorkflowSourceContext,
  type WorkflowSourceInput,
} from "./source-resolution.js";
import {
  validateWorkflowSource,
  type WorkflowValidationSummary,
} from "./workflow-validation.js";

interface PreparedWorkflowSource extends ResolvedWorkflowSource {
  validation: WorkflowValidationSummary;
}

export async function prepareWorkflowSource(
  hyperfide: HyperfidePluginApi,
  context: WorkflowSourceContext,
  input: WorkflowSourceInput,
): Promise<PreparedWorkflowSource> {
  const resolved = await resolveWorkflowSource(input, context, {
    async getThreadEnvironmentId(threadId) {
      const thread = await hyperfide.sdk.threads.get({ threadId });
      return thread.environmentId;
    },
    async getEnvironment(environmentId) {
      const environment = await hyperfide.sdk.environments.get({ environmentId });
      return {
        id: environment.id,
        projectId: environment.projectId,
        hostId: environment.hostId,
        path: environment.path,
      };
    },
    readFile(input) {
      return hyperfide.sdk.files.read(input);
    },
  });
  const validation = await validateWorkflowSource(
    resolved.source,
    resolved.environmentId,
    {
      listProviders(environmentId) {
        return hyperfide.sdk.providers.list({ environmentId });
      },
      loadModels(environmentId, providerId) {
        return hyperfide.sdk.providers.models({ environmentId, providerId });
      },
    },
  );
  return { ...resolved, validation };
}
