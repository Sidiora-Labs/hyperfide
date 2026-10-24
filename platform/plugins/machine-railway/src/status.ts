import { createHash } from "node:crypto";
import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import {
  createRailwayClient,
  redact,
  type Credentials,
  type CredentialsResolver,
  type RailwayClientFactory,
} from "./machine-ops.js";
import { readBootstrapState } from "./fleet-bootstrap.js";
import type { RailwayStatus } from "./status-contract.js";

type Store = HyperfidePluginApi["storage"]["kv"];
type Verification = Pick<
  RailwayStatus,
  | "verifiedAt"
  | "projectName"
  | "environmentName"
  | "region"
  | "sandboxCount"
  | "lastError"
>;
export async function railwayIdentity(credentials: Credentials) {
  const response = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query:
        "query($id: String!) { environment(id: $id) { name project { name } } }",
      variables: { id: credentials.environmentId },
    }),
  });
  const body = (await response.json()) as {
    errors?: { message: string }[];
    data?: { environment?: { name: string; project: { name: string } } };
  };
  if (!response.ok || body.errors?.length || !body.data?.environment)
    throw new Error(
      body.errors?.map((e) => e.message).join("; ") ||
        `Railway identity request failed (${response.status})`,
    );
  return {
    projectName: body.data.environment.project.name,
    environmentName: body.data.environment.name,
  };
}
export function createStatus(
  resolve: CredentialsResolver,
  store: Store,
  factory: RailwayClientFactory = createRailwayClient,
  identity = railwayIdentity,
) {
  const key = "railway/verification";
  const fingerprint = (credentials: Credentials) =>
    createHash("sha256").update(JSON.stringify(credentials)).digest("hex");
  const cleanVerification = (
    value: Verification,
    credentials: Credentials,
  ): Verification => ({
    ...value,
    projectName:
      value.projectName === null
        ? null
        : redact(value.projectName, credentials),
    environmentName:
      value.environmentName === null
        ? null
        : redact(value.environmentName, credentials),
    region: value.region === null ? null : redact(value.region, credentials),
    lastError:
      value.lastError === null ? null : redact(value.lastError, credentials),
  });
  const empty: Verification = {
    verifiedAt: null,
    projectName: null,
    environmentName: null,
    region: null,
    sandboxCount: null,
    lastError: null,
  };
  async function status(): Promise<RailwayStatus> {
    const credentials = await resolve();
    const cached = await store.get<Verification & { fingerprint: string }>(key);
    const verification =
      credentials && cached?.fingerprint === fingerprint(credentials)
        ? cleanVerification(cached, credentials)
        : empty;
    const machines = [];
    for (const key of await store.list("railway/allocation/")) {
      const allocation = await store.get<{
        pending?: boolean;
        id?: string | null;
        checkpoint?: string | null;
      }>(key);
      if (allocation)
        machines.push({
          phase: allocation.pending
            ? "allocating"
            : allocation.id
              ? "running"
              : allocation.checkpoint
                ? "suspended"
                : "removed",
        });
    }
    const bootstrap = await readBootstrapState(store);
    return {
      configured: !!credentials,
      verifiedAt: verification.verifiedAt,
      projectName: verification.projectName,
      environmentName: verification.environmentName,
      region: verification.region,
      sandboxCount: verification.sandboxCount,
      lastError: verification.lastError,
      machineCount: machines.filter((m) => m.phase !== "removed").length,
      machines,
      bootstrap: {
        ...bootstrap,
        lastError:
          bootstrap.lastError === null
            ? null
            : redact(bootstrap.lastError, credentials ?? undefined),
      },
    };
  }
  return {
    status,
    async verify(): Promise<RailwayStatus> {
      const credentials = await resolve();
      if (!credentials) return status();
      try {
        const client = await factory(credentials);
        const [identityResult, sandboxes] = await Promise.all([
          identity(credentials),
          client.list(),
        ]);
        const regions = [
          ...new Set(
            sandboxes.map((s) => s.region).filter((s): s is string => !!s),
          ),
        ];
        await store.set(key, {
          ...cleanVerification(
            {
              ...empty,
              ...identityResult,
              verifiedAt: new Date().toISOString(),
              sandboxCount: sandboxes.length,
              region: regions.join(", ") || null,
            },
            credentials,
          ),
          fingerprint: fingerprint(credentials),
        });
      } catch (error) {
        await store.set(key, {
          ...empty,
          fingerprint: fingerprint(credentials),
          lastError: redact(
            error instanceof Error ? error.message : String(error),
            credentials,
          ),
        });
      }
      return status();
    },
  };
}
