import type { TimelineConversationTurnRequest } from "@hyperfide/server-contract";
import { Icon, type IconName } from "@hyperfide/shared-ui/icon";
import { cn } from "@hyperfide/shared-ui/lib/utils";
import { turnRequestLabel } from "@hyperfide/client-core";

interface TurnRequestLabelProps {
  turnRequest: TimelineConversationTurnRequest;
  icon?: IconName;
}

export function TurnRequestLabel({
  turnRequest,
  icon = "CornerDownRight",
}: TurnRequestLabelProps) {
  const label = turnRequestLabel(turnRequest);
  if (label === null) {
    return null;
  }
  const isPendingSteer =
    turnRequest.kind === "steer" && turnRequest.status === "pending";
  return (
    <span
      className={cn(
        "shrink-0 whitespace-nowrap text-xs leading-none text-muted-foreground",
        isPendingSteer && "animate-shine",
      )}
    >
      <Icon name={icon} className="mr-1 inline-block size-3 align-middle" />
      {label}
    </span>
  );
}
