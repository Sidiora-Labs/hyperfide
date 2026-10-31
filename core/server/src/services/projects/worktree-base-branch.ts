import type { GitSourceInspection } from "@hyperfide/domain";

interface ResolveDefaultWorktreeBaseBranchArgs {
  defaultBranch: GitSourceInspection["defaultBranch"];
  defaultBranchRelation: GitSourceInspection["defaultBranchRelation"];
  originDefaultBranch: GitSourceInspection["originDefaultBranch"];
}

export function resolveDefaultWorktreeBaseBranch(
  args: ResolveDefaultWorktreeBaseBranchArgs,
): string | null {
  if (!args.originDefaultBranch) {
    return args.defaultBranch;
  }
  if (!args.defaultBranch) {
    return args.originDefaultBranch;
  }
  if (
    args.defaultBranchRelation === "equal" ||
    args.defaultBranchRelation === "local-behind"
  ) {
    return args.originDefaultBranch;
  }
  return args.defaultBranch;
}
