import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  captureTrustedRemoteAddress,
  getTrustedRemoteAddress,
  resolveRequestAppSurface,
  TRUSTED_REMOTE_ADDRESS_CONTEXT_KEY,
} from "../src/request-context.js";

describe("request context", () => {
  it("captures the trusted remote address from node connection metadata", async () => {
    const app = await new Hono();
    app.use("*", async (context, next) => {
      captureTrustedRemoteAddress(context);
      await next();
    });
    app.get("/", (context) =>
      context.json({
        address: getTrustedRemoteAddress(context),
      }),
    );

    const response = await app.fetch(new Request("http://example.test/"), {
      incoming: {
        socket: {
          remoteAddress: "127.0.0.1",
        },
      },
    });

    await expect(response.json()).resolves.toEqual({
      address: "127.0.0.1",
    });
  });

  it("stores undefined when connection metadata is unavailable", async () => {
    const app = await new Hono();
    app.get("/", (context) => {
      captureTrustedRemoteAddress(context);
      return context.json({
        hasAddress:
          context.get(TRUSTED_REMOTE_ADDRESS_CONTEXT_KEY) !== undefined,
      });
    });

    const response = await app.request("/");

    await expect(response.json()).resolves.toEqual({
      hasAddress: false,
    });
  });

  it("does not treat a loopback proxy peer as a trusted remote address", async () => {
    const app = await new Hono();
    app.use("*", async (context, next) => {
      captureTrustedRemoteAddress(context);
      await next();
    });
    app.get("/", (context) =>
      context.json({
        address: getTrustedRemoteAddress(context),
      }),
    );

    for (const header of [
      ["forwarded", "for=203.0.113.10"],
      ["x-forwarded-for", "203.0.113.10"],
      ["x-forwarded-host", "public.example"],
      ["x-forwarded-proto", "https"],
      ["x-real-ip", "203.0.113.10"],
    ]) {
      const response = await app.fetch(
        new Request("http://example.test/", {
          headers: { [header[0]]: header[1] },
        }),
        {
          incoming: {
            socket: {
              remoteAddress: "127.0.0.1",
            },
          },
        },
      );

      await expect(response.json()).resolves.toEqual({
        address: undefined,
      });
    }
  });
  it("resolves the app surface from the client header and falls back to api", async () => {
    const app = await new Hono();
    app.get("/", (context) =>
      context.json({ surface: resolveRequestAppSurface(context) }),
    );

    const surfaceFor = async (header: string | undefined): Promise<unknown> => {
      const response = await app.request(
        "/",
        header === undefined
          ? undefined
          : { headers: { "x-hyperfide-app-surface": header } },
      );
      const body = (await response.json()) as { surface: string };
      return body.surface;
    };

    await expect(surfaceFor("desktop")).resolves.toBe("desktop");
    await expect(surfaceFor("mobile")).resolves.toBe("mobile");
    await expect(surfaceFor(undefined)).resolves.toBe("api");
    await expect(surfaceFor("tv")).resolves.toBe("api");
  });
});
