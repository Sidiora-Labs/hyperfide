import type {
  SystemExecutionOptionsQuery,
  SystemExecutionOptionsResponse,
} from "@hyperfide/server-contract";
import type { HyperfideSdkTransport } from "../transport.js";

export interface CreateSdkAreaArgs {
  transport: HyperfideSdkTransport;
}

type SignalRequestOptions = { init: { signal: AbortSignal } };

export function signalRequestArgs(
  signal: AbortSignal | undefined,
): [] | [SignalRequestOptions] {
  return signal === undefined ? [] : [{ init: { signal } }];
}

export async function readExecutionOptions(
  transport: HyperfideSdkTransport,
  input: SystemExecutionOptionsQuery & { signal?: AbortSignal },
): Promise<SystemExecutionOptionsResponse> {
  return transport.readJson(
    transport.api.v1.system["execution-options"].$get(
      {
        query: {
          environmentId: input.environmentId,
          hostId: input.hostId,
          projectId: input.projectId,
          providerId: input.providerId,
        },
      },
      ...signalRequestArgs(input.signal),
    ),
  );
}
