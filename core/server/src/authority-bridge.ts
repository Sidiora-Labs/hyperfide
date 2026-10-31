import type { Hono } from "hono";
import {
  authorityConfiguration,
  createAuthorityClient,
  type AuthorityClient,
  type Receipt,
  type TransactionIdentity,
} from "@hyperfide/authority";

// Projection interface for lane/publication producers until their storage hooks land.
// The deployment operator is authenticated by the service; existing ingress auth
// continues to authenticate browser sessions and machine requests.
export function createAuthorityBridge(env: NodeJS.ProcessEnv = process.env) {
  const configuration = authorityConfiguration(env);
  let client: Promise<AuthorityClient> | undefined;
  const connect = () => (client ??= createAuthorityClient(configuration!));
  return {
    configured: configuration !== undefined,
    async operator() {
      return configuration ? (await connect()).operator() : null;
    },
    async status() {
      if (!configuration) return { status: "disabled" as const };
      try {
        return await (await connect()).health();
      } catch {
        return { status: "unavailable" as const };
      }
    },
    async record(receipt: Receipt, identity: TransactionIdentity) {
      if (!configuration) return null;
      const authority = await connect();
      await authority.operator();
      return authority.transaction([{ kind: "receipt", receipt }], identity);
    },
  };
}

export type AuthorityBridge = ReturnType<typeof createAuthorityBridge>;

export function registerAuthorityBridge(app: Hono, bridge: AuthorityBridge) {
  if (!bridge.configured) return;
  app.get("/authority/status", async (context) => context.json(await bridge.status()));
  app.use("*", async (context, next) => {
    try {
      await bridge.operator();
    } catch {
      return context.json({ code: "authority_operator_denied" }, 403);
    }
    return next();
  });
  app.get("/authority/operator", async (context) => context.json(await bridge.operator()));
  for (const kind of ["lane", "publication"] as const) {
    app.post(`/authority/receipts/${kind}`, async (context) => {
      let input: { receipt: Receipt; identity: TransactionIdentity };
      try {
        input = await context.req.json();
        if (!input?.receipt || input.receipt.kind !== kind ||
            typeof input.identity?.operationId !== "string" ||
            typeof input.identity?.idempotencyKey !== "string") throw Error();
      } catch {
        return context.json({ code: "invalid_receipt" }, 400);
      }
      // Caller-supplied identities survive retries; the authority validates all fields.
      return context.json(await bridge.record(input.receipt, input.identity));
    });
  }
}
