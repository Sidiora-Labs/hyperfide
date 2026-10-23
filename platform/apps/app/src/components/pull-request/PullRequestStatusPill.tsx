import type { PullRequest } from "hyperfide-plugin-bb--github-pr-status/contract";
import { Icon } from "@hyperfide/shared-ui/icon";
import { cn } from "@hyperfide/shared-ui/lib/utils";
import {
  describePullRequestStatus,
  getPullRequestStateDisplay,
  getPullRequestGithubCheckStatus,
} from "@/lib/pull-request-display";
import { GithubFaviconIcon } from "./GithubFaviconIcon";

const CHECKED_PULL_REQUEST_STATUS_MIN_WIDTH_CLASS = "min-w-9";
const SINGLE_PULL_REQUEST_STATUS_MIN_WIDTH_CLASS = "min-w-4";

export function PullRequestStateIcon({
  pullRequest,
  className,
}: {
  pullRequest: PullRequest;
  className?: string;
}) {
  const statusIcon = getPullRequestStateDisplay(pullRequest);
  return (
    <Icon
      name={statusIcon.icon}
      className={cn("size-4 shrink-0", statusIcon.className, className)}
      aria-hidden="true"
    />
  );
}

export function PullRequestStatusPill({
  pullRequest,
  className,
}: {
  pullRequest: PullRequest;
  className?: string;
}) {
  const checkStatus = getPullRequestGithubCheckStatus(pullRequest);
  return (
    <span
      title={describePullRequestStatus(pullRequest)}
      className={cn(
        "flex h-5 shrink-0 cursor-pointer items-center gap-1",
        checkStatus !== null
          ? CHECKED_PULL_REQUEST_STATUS_MIN_WIDTH_CLASS
          : SINGLE_PULL_REQUEST_STATUS_MIN_WIDTH_CLASS,
        className,
      )}
    >
      <PullRequestStateIcon pullRequest={pullRequest} />
      {checkStatus === null ? null : <GithubFaviconIcon status={checkStatus} />}
    </span>
  );
}
