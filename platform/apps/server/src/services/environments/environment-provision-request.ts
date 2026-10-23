import type { EnvironmentProvisionCommand } from "@hyperfide/host-daemon-contract";

export interface EnvironmentProvisionRequest {
  command: EnvironmentProvisionCommand;
}
