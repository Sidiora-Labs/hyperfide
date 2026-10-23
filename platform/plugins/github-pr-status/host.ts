import { access } from "node:fs/promises";
import { experimental_defineHostEntry } from "@hyperfide/plugin-sdk/host";
import { getCurrentBranch } from "hyperfide-environment-provider-host/git";
import { githubPrStatusHostContract } from "./contract.js";
import {
  getPullRequestForCurrentBranch,
  runPullRequestActionForCurrentBranch,
} from "./host/git-host.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export default experimental_defineHostEntry({
  contract: githubPrStatusHostContract,
  handlers: {
    async view({ path }) {
      if (!(await pathExists(path))) {
        return {
          outcome: "unavailable" as const,
          message: `Workspace path no longer exists: ${path}`,
        };
      }
      const localBranch = await getCurrentBranch(path);
      if (!localBranch) return { outcome: "none" as const };
      return getPullRequestForCurrentBranch({ cwd: path, localBranch });
    },
    async act({ path, action }) {
      const localBranch = await getCurrentBranch(path);
      if (!localBranch) {
        return {
          ok: false as const,
          message: "Cannot update pull request from a detached workspace",
        };
      }
      return runPullRequestActionForCurrentBranch({
        cwd: path,
        localBranch,
        action,
      });
    },
  },
});
