import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestAppSurface } from "@bb/config/app-surface";
import type { RecordTelemetryEventRequest } from "@bb/server-contract";
import type { ServerLogger } from "../../types.js";

const telemetryAppSurfaceStorage = new AsyncLocalStorage<RequestAppSurface>();

export type TelemetryInitiator =
  | "user"
  | "agent"
  | "automation"
  | "plugin"
  | "system";

export type TurnFinishedOutcome = "succeeded" | "failed" | "stopped";
export type TurnErrorCategory =
  | "none"
  | "auth"
  | "billing"
  | "rate_limit"
  | "limit_reached"
  | "provider_unavailable"
  | "start_failed"
  | "process_exited"
  | "host_lost"
  | "other";

export type TelemetryEvent =
  | {
      name: "turn_finished";
      properties: {
        outcome: TurnFinishedOutcome;
        error_category: TurnErrorCategory;
        provider: string;
        install_turn_number: number;
      };
    }
  | { name: "app_started" }
  | {
      name: "thread_created";
      properties: {
        is_child_thread: boolean;
        provider: string;
        initiator?: TelemetryInitiator;
      };
    }
  | {
      name: "user_message_sent";
      properties: {
        is_child_thread: boolean;
        message_source: "queued_message" | "thread_create" | "thread_send";
        provider: string;
        initiator?: TelemetryInitiator;
      };
    }
  | {
      name: "plugin_installed";
      properties: {
        plugin_id: string | null;
        provenance: "builtin" | "catalog" | "direct";
        marketplace: string | null;
        source_kind: "builtin" | "git" | "npm" | "path";
      };
    }
  | RecordTelemetryEventRequest;

export interface TelemetryService {
  capture(event: TelemetryEvent): void;
  isEnabled(): boolean;
}

export function createNoopTelemetryService(): TelemetryService {
  return { isEnabled: () => false, capture: () => {} };
}

export function runWithTelemetryAppSurface<T>(
  appSurface: RequestAppSurface,
  callback: () => T,
): T {
  return telemetryAppSurfaceStorage.run(appSurface, callback);
}

export async function createTelemetryService(args: {
  logger: ServerLogger;
}): Promise<TelemetryService> {
  return {
    isEnabled: () => true,
    capture(event): void {
      args.logger.debug(
        { event, appSurface: telemetryAppSurfaceStorage.getStore() },
        "Local event",
      );
    },
  };
}
