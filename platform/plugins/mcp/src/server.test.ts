import { createFakePluginHost } from "@hyperfide/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./server.js";

interface RpcCall {
  pluginId: string;
  method: string;
  input?: unknown;
}

interface AccountBehaviour {
  serverUrl: string | null;
  fetch: (input: { method: string; path: string; body: unknown }) => {
    status: number;
    body: unknown;
  };
}

async function load(account: AccountBehaviour) {
  const calls: RpcCall[] = [];
  const host = createFakePluginHost({
    pluginId: "hyperfide--mcp",
    loopbackBaseUrl: "http://127.0.0.1:4000",
    sdk: {
      plugins: {
        callRpc: async (args: RpcCall) => {
          calls.push(args);
          if (args.method === "hyperfide-account.v1.status") {
            return account.serverUrl === null
              ? { state: "signed-out", account: null }
              : {
                  state: "signed-in",
                  account: { serverUrl: account.serverUrl },
                };
          }
          return account.fetch(
            args.input as { method: string; path: string; body: unknown },
          );
        },
      },
    },
  });
  await plugin(host.hyperfide);
  return { host, calls };
}

const SIGNED_OUT: AccountBehaviour = {
  serverUrl: null,
  fetch: () => ({ status: 401, body: null }),
};

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
});

function mcpRequest(headers: Record<string, string>): RequestInit {
  return {
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: INITIALIZE,
  };
}

describe("MCP route", () => {
  it("answers a local caller and a gate caller holding an OAuth token for hyperfide", async () => {
    const { host } = await load(SIGNED_OUT);
    const accepted: Record<string, string>[] = [
      {},
      { "x-hyperfide-gate-auth": "oauth", "x-hyperfide-gate-oauth-scope": "hyperfide" },
    ];
    for (const headers of accepted) {
      const response = await host.harness.fetchHttp(
        "POST",
        "/mcp",
        mcpRequest(headers),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('"name":"hyperfide"');
    }
  });

  it("refuses web pages and gate callers that are not OAuth clients before any MCP handling", async () => {
    const { host } = await load(SIGNED_OUT);
    const refused: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { "x-hyperfide-gate-auth": "session" },
      { "x-hyperfide-gate-auth": "machine" },
      { "x-hyperfide-gate-auth": "oauth", "x-hyperfide-gate-oauth-scope": "openid" },
    ];
    for (const headers of refused) {
      const response = await host.harness.fetchHttp(
        "POST",
        "/mcp",
        mcpRequest(headers),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "forbidden" });
    }
  });
});

describe("hyperfide mcp", () => {
  it("prints the local address, and the remote one only when signed in", async () => {
    const signedOut = await load(SIGNED_OUT);
    expect(
      JSON.parse(
        (await signedOut.host.harness.runCli(["status", "--json"])).stdout,
      ),
    ).toEqual({
      remoteUrl: null,
      localUrl: "http://127.0.0.1:4000/api/v1/plugins/hyperfide--mcp/http/mcp",
      accountError: null,
    });

    const signedIn = await load({
      serverUrl: "https://sawyer.hyperfide.example/",
      fetch: () => ({ status: 200, body: { grants: [] } }),
    });
    expect(
      JSON.parse(
        (await signedIn.host.harness.runCli(["status", "--json"])).stdout,
      ).remoteUrl,
    ).toBe("https://sawyer.hyperfide.example/mcp");
  });

  it("lists connected apps through the account service", async () => {
    const { host, calls } = await load({
      serverUrl: "https://sawyer.hyperfide.example",
      fetch: () => ({
        status: 200,
        body: {
          grants: [
            {
              id: "grant_1",
              clientId: "https://claude.ai/oauth/client.json",
              clientName: "Claude",
              serverId: "srv_1",
              serverHandle: "sawyer",
              scope: "hyperfide",
              createdAt: Date.UTC(2026, 9, 11),
              lastUsedAt: null,
            },
          ],
        },
      }),
    });
    const listed = await host.harness.runCli(["clients"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toBe(
      "grant_1  Claude  connected 2026-10-11T00:00:00.000Z  never used",
    );
    expect(calls.at(-1)).toMatchObject({
      pluginId: "hyperfide-account",
      method: "hyperfide-account.v1.fetch",
      input: {
        target: "api",
        method: "GET",
        path: "/api/mcp/grants",
        body: null,
      },
    });
  });

  it("revokes a grant and reports an unknown id as a failure", async () => {
    const revoked: unknown[] = [];
    const { host } = await load({
      serverUrl: "https://sawyer.hyperfide.example",
      fetch: (input) => {
        revoked.push(input.body);
        return {
          status: 200,
          body: {
            revoked: (input.body as { grantId: string }).grantId === "grant_1",
          },
        };
      },
    });
    expect((await host.harness.runCli(["revoke", "grant_1"])).exitCode).toBe(0);
    const unknown = await host.harness.runCli(["revoke", "grant_x", "--json"]);
    expect(unknown.exitCode).not.toBe(0);
    expect(JSON.parse(unknown.stdout)).toMatchObject({
      ok: false,
      error: { code: "unknown_grant" },
    });
    expect(revoked).toEqual([{ grantId: "grant_1" }, { grantId: "grant_x" }]);
  });

  it("tells a signed-out hyperfide to sign in instead of failing obscurely", async () => {
    const { host } = await load(SIGNED_OUT);
    const result = await host.harness.runCli(["clients", "--json"]);
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "not_signed_in" },
    });
  });
});
