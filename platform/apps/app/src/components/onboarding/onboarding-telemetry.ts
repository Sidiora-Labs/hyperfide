import type { RecordTelemetryEventRequest } from "@bb/server-contract";

export type OnboardingEntry = "first_run" | "replay";

export function recordTelemetryEvent(event: RecordTelemetryEventRequest): void {
  console.debug("Local event", event);
}
