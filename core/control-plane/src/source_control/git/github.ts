import {
  SourceControlError,
  parseSourceScope,
  type SourceScope,
} from "../contracts.js";
import { sourceDigest } from "../metadata.js";
import { createHttpsGitTransport, gitRef } from "./transport.js";
import type { SourceGitCredential, SourceGitDestination } from "./types.js";
export interface GitHubDestinationInput {
  scope: SourceScope;
  id: string;
  repository_identity: string;
  remote_url: string;
  allowed_refs: readonly string[];
  credentials: () => Promise<SourceGitCredential>;
}
export function createGitHubDestination(
  input: GitHubDestinationInput,
): SourceGitDestination {
  const url = new URL(input.remote_url);
  if (
    url.hostname !== "github.com" ||
    !/^\/[^/]+\/[^/]+\.git$/.test(url.pathname)
  )
    throw new SourceControlError(
      "INVALID_DESTINATION",
      "GitHub publication requires an exact github.com owner/repository.git URL",
    );
  input.allowed_refs.forEach(gitRef);
  return {
    scope: parseSourceScope(input.scope),
    id: input.id,
    provider: "github",
    repository_identity: input.repository_identity,
    remote_key: sourceDigest([
      "git-remote",
      "github",
      url.toString().toLowerCase(),
    ]),
    configuration_digest: sourceDigest([
      "github",
      url.toString(),
      input.repository_identity,
      input.allowed_refs,
    ]),
    allowed_refs: [...input.allowed_refs],
    transport: createHttpsGitTransport(input),
  };
}
