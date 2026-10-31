import type { PermissionEscalation } from "@hyperfide/domain";

export interface InteractiveRequestPolicyInput {
  permissionEscalation: PermissionEscalation | null;
}

export function shouldAutoDenyInteractiveRequest(
  policy: InteractiveRequestPolicyInput,
): boolean {
  return policy.permissionEscalation === "deny";
}
