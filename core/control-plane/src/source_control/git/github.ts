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
export interface GitHubDestinationInput {
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
export function createGitHubDestination(
  input: GitHubDestinationInput,
): SourceGitDestination {
  const url = new URL(input.remote_url);
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.hostname !== "github.com" ||
    !/^\/[^/]+\/[^/]+\.git$/.test(url.pathname)
  )
    throw new SourceControlError(
      "INVALID_DESTINATION",
      "GitHub publication requires an exact github.com owner/repository.git URL",
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
      const repository = url.pathname
        .slice(1, -4)
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      const endpoint = "https://api.github.com/repos/" + repository;
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
          "GitHub repository identity differs from configuration",
        );
      const branch = encodeURIComponent(ref.slice("refs/heads/".length));
      const protection = await read("/branches/" + branch + "/protection");
      const rules = await read("/rules/branches/" + branch);
      if (!Array.isArray(rules))
        throw new SourceControlError(
          "PROTECTION_UNSATISFIED",
          "GitHub effective rules are unavailable",
        );
      const types = new Set(rules.map((rule) => record(rule).type));
      const classic = protection === null ? null : record(protection);
      const disabled = (value: unknown) =>
        value !== undefined && record(value).enabled === false;
      const noForce =
        types.has("non_fast_forward") ||
        (classic !== null && disabled(classic.allow_force_pushes));
      const noDeletion =
        types.has("deletion") ||
        (classic !== null && disabled(classic.allow_deletions));
      const rules_digest = sourceDigest({
        branch_protection: protection,
        rules,
      });
      if (
        !noForce ||
        !noDeletion ||
        (expectedRules !== undefined && rules_digest !== expectedRules)
      )
        throw new SourceControlError(
          "PROTECTION_UNSATISFIED",
          "GitHub destination protection differs from configuration",
        );
      return { repository_identity: String(identity.id), rules_digest };
    },
    transport: createHttpsGitTransport(input),
  };
}
