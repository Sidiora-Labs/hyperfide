import {
  SourceControlError,
  parseSourceScope,
  type SourceScope,
} from "../contracts.js";
import { sourceDigest } from "../metadata.js";
import {
  createHttpsGitTransport,
  gitRef,
  readGitProviderJSON,
} from "./transport.js";
import type {
  SourceGitCredential,
  SourceGitDestination,
  SourceGitProtection,
  SourceGitTransport,
} from "./types.js";
export interface GitLabDestinationInput {
  scope: SourceScope;
  id: string;
  repository_identity: string;
  remote_url: string;
  allowed_refs: readonly string[];
  credentials: () => Promise<SourceGitCredential>;
  protection?: SourceGitProtection;
  fetch?: typeof globalThis.fetch;
  cleanupCredential?: SourceGitTransport["cleanupCredential"];
}
export function createGitLabDestination(
  input: GitLabDestinationInput,
): SourceGitDestination {
  const url = new URL(input.remote_url);
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.hostname !== "gitlab.com" ||
    !/^\/(?:[^/]+\/)+[^/]+\.git$/.test(url.pathname)
  )
    throw new SourceControlError(
      "INVALID_DESTINATION",
      "GitLab publication requires an exact gitlab.com namespace/repository.git URL",
    );
  input.allowed_refs.forEach(gitRef);
  const expectedRules = input.protection?.rules_digest;
  if (
    expectedRules !== undefined &&
    !/^sha256:[a-f0-9]{64}$/.test(expectedRules)
  )
    throw new SourceControlError(
      "INVALID_DESTINATION",
      "Protection rules require a namespaced digest",
    );
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new SourceControlError(
        "PROTECTION_UNSATISFIED",
        "Invalid provider protection response",
      );
    return value as Record<string, unknown>;
  };

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
      {
        schema_version: 1,
        protection: expectedRules ?? "protected-no-force-push",
      },
    ]),
    allowed_refs: [...input.allowed_refs],

    async observeProtection(ref, credential, signal) {
      if (
        !input.allowed_refs.includes(gitRef(ref)) ||
        !ref.startsWith("refs/heads/")
      )
        throw new SourceControlError(
          "PROTECTION_UNSATISFIED",
          "An explicitly configured protected branch is required",
        );
      const repository = url.pathname.slice(1, -4);
      const endpoint =
        "https://gitlab.com/api/v4/projects/" + encodeURIComponent(repository);
      const read = (suffix: string) =>
        readGitProviderJSON(endpoint + suffix, credential, signal, input.fetch);
      const identity = record(await read(""));
      if (
        typeof identity.id !== "number" ||
        !Number.isSafeInteger(identity.id) ||
        identity.id < 1 ||
        String(identity.id) !== input.repository_identity ||
        identity.archived === true
      )
        throw new SourceControlError(
          "PROTECTION_UNSATISFIED",
          "GitLab repository identity differs from configuration",
        );
      const branch = ref.slice("refs/heads/".length);
      const protection = record(
        await read("/protected_branches/" + encodeURIComponent(branch)),
      );
      const rules_digest = sourceDigest(protection);
      if (
        protection.name !== branch ||
        protection.allow_force_push !== false ||
        !Array.isArray(protection.push_access_levels) ||
        protection.push_access_levels.length === 0 ||
        (expectedRules !== undefined && rules_digest !== expectedRules)
      )
        throw new SourceControlError(
          "PROTECTION_UNSATISFIED",
          "GitLab destination protection differs from configuration",
        );
      return { repository_identity: String(identity.id), rules_digest };
    },
    transport: createHttpsGitTransport(input),
  };
}
