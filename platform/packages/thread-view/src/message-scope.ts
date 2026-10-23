import { threadScope, turnScope } from "@bb/domain";
import type { ThreadEventScope } from "@bb/domain";
import type { EventProjectionMessageBase } from "./event-projection-types.js";

export function areThreadEventScopesEqual(
  left: ThreadEventScope,
  right: ThreadEventScope,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "thread") {
    return true;
  }
  return right.kind === "turn" && left.turnId === right.turnId;
}

export function haveCompatibleEventProjectionMessageScope(
  left: Pick<EventProjectionMessageBase, "scope">,
  right: Pick<EventProjectionMessageBase, "scope">,
): boolean {
  return areThreadEventScopesEqual(left.scope, right.scope);
}

export function getEventProjectionMessageScopeTurnId(
  message: Pick<EventProjectionMessageBase, "scope">,
): string | null {
  return message.scope.kind === "turn" ? message.scope.turnId : null;
}

export function eventProjectionMessageTurnScopeFields(
  turnId: string,
): Pick<EventProjectionMessageBase, "scope"> {
  return { scope: turnScope(turnId) };
}

export function eventProjectionMessageThreadScopeFields(): Pick<
  EventProjectionMessageBase,
  "scope"
> {
  return { scope: threadScope() };
}
