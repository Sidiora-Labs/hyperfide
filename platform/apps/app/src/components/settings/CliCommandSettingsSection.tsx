import type { SystemCliCommandStatus } from "@hyperfide/server-contract";
import { Button } from "@hyperfide/shared-ui/button";
import {
  SettingsSection,
  SettingsWithControl,
} from "@/components/ui/settings-section";
import { useChangeCliCommand } from "@/hooks/mutations/settings-mutations";
import { useCliCommandStatus } from "@/hooks/queries/system-queries";

const CLI_COMMAND_SETTING_LABEL = "hyperfide CLI";

interface CliCommandSettingsSectionContentProps {
  onChange: (change: "install" | "remove") => void;
  pending: boolean;
  status: SystemCliCommandStatus;
}

export function describeCliCommandStatus(
  status: SystemCliCommandStatus,
): string {
  if (status.installedPath !== null) {
    return status.onPath
      ? `Installed at ${status.installedPath}. You can control hyperfide from any terminal, and so can agents outside hyperfide, such as Claude Code or Codex.`
      : `Installed at ${status.installedPath}, but its folder is not on your PATH. Add the folder to your PATH to use hyperfide outside hyperfide.`;
  }
  if (status.shadowedBy === null) {
    return "Install the hyperfide CLI for use outside hyperfide. You can control hyperfide from any terminal, and so can agents outside hyperfide, such as Claude Code or Codex. Threads in hyperfide already have it.";
  }
  if (status.shadowedBy.source === "npm") {
    return `Already installed for use outside hyperfide at ${status.shadowedBy.path}, by npm.`;
  }
  if (status.shadowedBy.source === "machine") {
    return `Already installed for use outside hyperfide at ${status.shadowedBy.path}, with the hyperfide machine on this computer.`;
  }
  return `Another hyperfide at ${status.shadowedBy.path} comes first on your PATH. Remove it to install this one.`;
}

export function CliCommandSettingsSectionContent({
  onChange,
  pending,
  status,
}: CliCommandSettingsSectionContentProps) {
  const installed = status.installedPath !== null;
  return (
    <SettingsSection title="Command line">
      <SettingsWithControl
        controlPlacement="trailing"
        label={CLI_COMMAND_SETTING_LABEL}
        {...(installed ? { labelBadge: "Installed" } : {})}
        description={describeCliCommandStatus(status)}
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending || (!installed && status.shadowedBy !== null)}
          onClick={() => onChange(installed ? "remove" : "install")}
          aria-label={`${installed ? "Remove" : "Install"} ${CLI_COMMAND_SETTING_LABEL}`}
        >
          {installed ? "Remove" : "Install"}
        </Button>
      </SettingsWithControl>
    </SettingsSection>
  );
}

export function CliCommandSettingsSection() {
  const statusQuery = useCliCommandStatus();
  const changeCliCommand = useChangeCliCommand();
  const status = statusQuery.data;
  if (status === undefined || !status.supported) {
    return null;
  }

  return (
    <CliCommandSettingsSectionContent
      status={status}
      pending={changeCliCommand.isPending || statusQuery.isRefetching}
      onChange={(change) =>
        changeCliCommand.mutate(change, {
          onSettled: () => {
            void statusQuery.refetch();
          },
        })
      }
    />
  );
}
