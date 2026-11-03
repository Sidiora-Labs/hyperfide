import {
  SourceControlError,
  parseSourceScope,
  type SourceScope,
} from "../contracts.js";
import { sourceDigest } from "../metadata.js";
import { createHttpsGitTransport, gitRef } from "./transport.js";
import type { SourceGitCredential, SourceGitDestination } from "./types.js";
export interface GitLabDestinationInput {
  scope: SourceScope;
  id: string;
  repository_identity: string;
  remote_url: string;
  allowed_refs: readonly string[];
  credentials: () => Promise<SourceGitCredential>;
}
export function createGitLabDestination(
  input: GitLabDestinationInput,
): SourceGitDestination {
  const url = new URL(input.remote_url);
  if (
    url.hostname !== "gitlab.com" ||
    !/^\/(?:[^/]+\/)+[^/]+\.git$/.test(url.pathname)
  )
    throw new SourceControlError(
      "INVALID_DESTINATION",
      "GitLab publication requires an exact gitlab.com namespace/repository.git URL",
    );
  input.allowed_refs.forEach(gitRef);
  return {
    scope: parseSourceScope(input.scope),
    id: input.id,
    provider: "gitlab",
    repository_identity: input.repository_identity,
    remote_key: sourceDigest(["git-remote", "gitlab", url.toString()]),
    configuration_digest: sourceDigest([
      "gitlab",
      url.toString(),
      input.repository_identity,
      input.allowed_refs,
    ]),
    allowed_refs: [...input.allowed_refs],
    transport: createHttpsGitTransport(input),
  };
}
