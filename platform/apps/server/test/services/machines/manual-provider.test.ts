import { expect, it, vi } from "vitest";
import { defaultAppSettings } from "@hyperfide/domain";
import { getHost, openSession, setAppSettings } from "@hyperfide/db";
import { withTestHarness } from "../../helpers/test-app.js";
import { seedHost, seedPrimaryHost } from "../../helpers/seed.js";

it("creates, enrolls, and removes a manual machine by host id", async () => {
  await withTestHarness(async (harness) => {
    seedPrimaryHost(harness.deps, "local");
    await seedHost(harness.deps, { id: "local" });
    await setAppSettings(harness.db, {
      ...defaultAppSettings,
      defaultMachineAccess: "direct",
      machineServerUrl: "https://machine.example.test",
    });
    const response = await harness.app.request("/api/v1/hosts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: "manual-host",
        machineProviderId: "manual",
        inputs: null,
      }),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    await vi.waitFor(async () =>
      expect(await getHost(harness.db, created.id)).toMatchObject({
        phase: "creating",
        statusMessage: "Run the enrollment command shown below",
      }),
    );
    const commandResponse = await harness.app.request(
      `/api/v1/hosts/${created.id}/enrollment-command`,
    );
    expect(commandResponse.status).toBe(200);
    const enrollment = (await commandResponse.json()) as {
      command: string;
      expiresAt: number;
    };
    const credential = enrollment.command.match(
      /X-BB-Enrollment: ([^']+)/u,
    )?.[1];
    expect(credential).toBeTruthy();
    expect(JSON.stringify(await getHost(harness.db, created.id))).not.toContain(
      credential,
    );

    const enrolled = await harness.deps.machineAuth.enrollHost({
      hostId: created.id,
      token: credential!,
    });
    expect(enrolled).not.toBeNull();
    await openSession(harness.db, {
      hostId: created.id,
      instanceId: "manual-instance",
      hostName: "Studio Mac",
      dataDir: "/tmp/studio-mac",
      protocolVersion: 1,
      heartbeatIntervalMs: 5_000,
      leaseTimeoutMs: 30_000,
    });
    await harness.hub.registerDaemon("manual-session", created.id, {
      close() {},
      send() {},
    });
    await expect
      .poll(async () => (await getHost(harness.db, created.id))?.phase)
      .toBe("active");
    expect(await getHost(harness.db, created.id)).toMatchObject({
      launchKey: "manual-host",
      machineProviderId: "manual",
      name: "Studio Mac",
      resource: { key: "manual-host" },
    });
    expect(
      await (
        await harness.app.request(
          `/api/v1/hosts/${created.id}/enrollment-command`,
        )
      ).json(),
    ).toBeNull();

    const removed = await harness.app.request(`/api/v1/hosts/${created.id}`, {
      method: "DELETE",
    });
    expect({
      status: removed.status,
      body: await removed.clone().json(),
    }).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect((await getHost(harness.db, created.id))?.phase).toBe("destroyed");
  });
});
