import {
  findForeignManagedEnvironmentAtHostPath,
  findProjectEnvironmentByHostPath,
  type DbConnection,
} from "@hyperfide/db";
import { isHyperfideManagedWorkspacePath } from "./workspace-paths.js";

interface ForeignProjectPathCheckArgs {
  hostId: string;
  path: string;
  projectId: string;
}

interface SuppliedWorkspacePathCheckArgs extends ForeignProjectPathCheckArgs {
  dataDir: string | null;
}

const FOREIGN_PROJECT_REFUSAL =
  "Workspace path is a hyperfide-managed workspace owned by another project";

const UNRECORDED_MANAGED_REFUSAL =
  "Workspace path is inside hyperfide-managed storage but is not a workspace of this project";

export function foreignProjectOwnedPathRefusal(
  db: DbConnection,
  args: ForeignProjectPathCheckArgs,
): string | null {
  return findForeignManagedEnvironmentAtHostPath(db, {
    hostId: args.hostId,
    path: args.path,
    projectId: args.projectId,
  })
    ? FOREIGN_PROJECT_REFUSAL
    : null;
}

export function suppliedWorkspacePathRefusal(
  db: DbConnection,
  args: SuppliedWorkspacePathCheckArgs,
): string | null {
  const foreign = foreignProjectOwnedPathRefusal(db, args);
  if (foreign !== null) return foreign;

  if (
    args.dataDir !== null &&
    isHyperfideManagedWorkspacePath({ dataDir: args.dataDir, path: args.path }) &&
    findProjectEnvironmentByHostPath(
      db,
      args.projectId,
      args.hostId,
      args.path,
    ) === null
  ) {
    return UNRECORDED_MANAGED_REFUSAL;
  }

  return null;
}
