import { Hono } from "hono";
import { beforeEach, expect, test, vi } from "vitest";
import { createAuthorityBridge, registerAuthorityBridge } from "./authority-bridge.js";

const client = vi.hoisted(() => ({
  operator: vi.fn(), health: vi.fn(), transaction: vi.fn(),
}));
vi.mock("@hyperfide/authority", () => ({
  authorityConfiguration: (env: NodeJS.ProcessEnv) => env.HYPERFIDE_AUTHORITY_URL ? {} : undefined,
  createAuthorityClient: vi.fn(async () => client),
}));

beforeEach(() => {
  vi.clearAllMocks();
  client.operator.mockResolvedValue({ credential_id: "operator", role: "OPERATOR" });
  client.health.mockResolvedValue({ status: "ready" });
  client.transaction.mockResolvedValue({ committed: true, count: 1 });
});

function setup(configured = true) {
  const bridge = createAuthorityBridge(configured ? { HYPERFIDE_AUTHORITY_URL: "https://authority" } : {});
  const app = new Hono();
  registerAuthorityBridge(app, bridge);
  app.get("/projects", (c) => c.json({ ok: true }));
  return { app, bridge };
}

test("unset authority preserves local requests without calls", async () => {
  const { app, bridge } = setup(false);
  expect((await app.request("/projects")).status).toBe(200);
  expect(await bridge.status()).toEqual({ status: "disabled" });
  expect(client.operator).not.toHaveBeenCalled();
  expect(client.health).not.toHaveBeenCalled();
});

test("configured server checks operator and refuses requests when authority denies", async () => {
  const { app } = setup();
  expect((await app.request("/projects")).status).toBe(200);
  client.operator.mockRejectedValue(new Error("denied"));
  expect((await app.request("/projects")).status).toBe(403);
});

test("authority status remains visible during outage", async () => {
  const { app } = setup();
  expect(await (await app.request("/authority/status")).json()).toEqual({ status: "ready" });
  client.operator.mockRejectedValue(new Error("offline"));
  client.health.mockRejectedValue(new Error("offline"));
  expect(await (await app.request("/authority/status")).json()).toEqual({ status: "unavailable" });
});

test.each(["lane", "publication"])("server records %s receipts with stable transaction identity", async (kind) => {
  const { app } = setup();
  const receipt = { id: "receipt", kind, subject: "task" };
  const identity = { operationId: "operation", idempotencyKey: "retry" };
  const response = await app.request(`/authority/receipts/${kind}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ receipt, identity }),
  });
  expect(response.status).toBe(200);
  expect(client.transaction).toHaveBeenCalledWith([{ kind: "receipt", receipt }], identity);
  const invalid = await app.request(`/authority/receipts/${kind}`, { method: "POST", body: "{}" });
  expect(invalid.status).toBe(400);
});
