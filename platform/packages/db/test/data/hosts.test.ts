import { describe, expect, it, vi } from "vitest";
import { noopNotifier } from "../../src/notifier.js";
import {
  getHost,
  getNonDestroyedHost,
  listNonDestroyedHostsByIds,
  listPublicHosts,
  markHostSeen,
  updateHost,
  upsertHost,
} from "../../src/data/hosts.js";
import { createMigratedConnection } from "../../src/testing.js";

async function setup() {
  const db = await createMigratedConnection();
  return { db };
}

describe("hosts", () => {
  it("upsert creates a new host", async () => {
    const { db } = await setup();
    const host = await upsertHost(db, noopNotifier, {
      name: "My Machine",
    });

    expect(host.id).toMatch(/^host_/);
    expect(host.name).toBe("My Machine");
    expect(host.machineProviderId).toBeNull();
    expect(host.lastSeenAt).toBeNull();
  });

  it("upsert with same ID preserves the display name and lastSeenAt", async () => {
    const { db } = await setup();
    const host1 = await upsertHost(db, noopNotifier, {
      connectMachineId: "machine-1",
      name: "My Machine",
    });

    await markHostSeen(db, host1.id, 1_000);

    const host2 = await upsertHost(db, noopNotifier, {
      connectMachineId: "machine-2",
      id: host1.id,
      name: "Updated Reported Name",
    });

    expect(host2.id).toBe(host1.id);
    expect(host2.name).toBe("My Machine");
    expect(host2.connectMachineId).toBe("machine-2");
    expect(host2.lastSeenAt).toBe(1_000);
  });

  it("preserves destroyedAt when omitted on update", async () => {
    const { db } = await setup();
    const host = await upsertHost(db, noopNotifier, {
      destroyedAt: 123,
      name: "Disconnected Host",
    });

    const updated = await upsertHost(db, noopNotifier, {
      id: host.id,
      name: "Disconnected Host Renamed",
    });

    expect(updated).toMatchObject({
      destroyedAt: 123,
      id: host.id,
      name: "Disconnected Host",
    });
  });

  it("notifies when upsertHost updates connection state", async () => {
    const { db } = await setup();
    const notifyHost = vi.fn();
    const notifier = {
      notifyEnvironment() {},
      notifyHost,
      notifyProject() {},
      notifySystem() {},
      notifyThread() {},
    };
    const host = await upsertHost(db, notifier, {
      destroyedAt: 123,
      name: "Persistent Host",
    });
    notifyHost.mockClear();

    await upsertHost(db, notifier, {
      destroyedAt: null,
      id: host.id,
      name: "Persistent Host",
    });

    expect(notifyHost).toHaveBeenCalledWith(host.id, ["host-connected"]);
  });

  it("does not notify when upsertHost changes metadata without a connection-state change", async () => {
    const { db } = await setup();
    const notifyHost = vi.fn();
    const notifier = {
      notifyEnvironment() {},
      notifyHost,
      notifyProject() {},
      notifySystem() {},
      notifyThread() {},
    };
    const host = await upsertHost(db, notifier, {
      name: "Persistent Host",
    });
    notifyHost.mockClear();

    await upsertHost(db, notifier, {
      id: host.id,
      name: "Persistent Host Renamed",
    });

    expect(notifyHost).not.toHaveBeenCalled();
  });

  it("lists only non-destroyed hosts for the public inventory", async () => {
    const { db } = await setup();
    const visibleHost = await upsertHost(db, noopNotifier, {
      id: "host-visible",
      name: "Visible Host",
    });
    const ephemeralHost = await upsertHost(db, noopNotifier, {
      id: "host-ephemeral",
      name: "Ephemeral Host",
    });
    const destroyedHost = await upsertHost(db, noopNotifier, {
      id: "host-destroyed",
      name: "Destroyed Host",
    });
    await updateHost(db, noopNotifier, ephemeralHost.id, { phase: "creating" });
    await updateHost(db, noopNotifier, destroyedHost.id, { destroyedAt: 123 });

    expect((await listPublicHosts(db)).map((host) => host.id)).toEqual([
      visibleHost.id,
    ]);
    expect(
      (await listPublicHosts(db, { includeCreating: true })).map(
        (host) => host.id,
      ),
    ).toEqual([visibleHost.id, ephemeralHost.id]);
  });

  it("filters the public inventory by host type", async () => {
    const { db } = await setup();
    const persistentHost = await upsertHost(db, noopNotifier, {
      id: "host-persistent",
      name: "Persistent Host",
    });
    const ephemeralHost = await upsertHost(db, noopNotifier, {
      id: "host-ephemeral",
      name: "Ephemeral Host",
      type: "ephemeral",
    });

    expect(
      (await listPublicHosts(db, { type: "persistent" })).map(
        (host) => host.id,
      ),
    ).toEqual([persistentHost.id]);
    expect(
      (await listPublicHosts(db, { type: "ephemeral" })).map((host) => host.id),
    ).toEqual([ephemeralHost.id]);
  });

  it("filters destroyed hosts from non-destroyed lookups", async () => {
    const { db } = await setup();
    const visibleHost = await upsertHost(db, noopNotifier, {
      id: "host-visible",
      name: "Visible Host",
    });
    const destroyedHost = await upsertHost(db, noopNotifier, {
      id: "host-destroyed",
      name: "Destroyed Host",
    });

    await updateHost(db, noopNotifier, destroyedHost.id, { destroyedAt: 123 });

    expect((await getNonDestroyedHost(db, visibleHost.id))?.id).toBe(
      visibleHost.id,
    );
    expect(await getNonDestroyedHost(db, destroyedHost.id)).toBeNull();
    expect(
      (
        await listNonDestroyedHostsByIds(db, [visibleHost.id, destroyedHost.id])
      ).map((host) => host.id),
    ).toEqual([visibleHost.id]);
  });

  it("notifies when updateHost changes host connection state", async () => {
    const { db } = await setup();
    const notifyHost = vi.fn();
    const notifier = {
      notifyEnvironment() {},
      notifyHost,
      notifyProject() {},
      notifySystem() {},
      notifyThread() {},
    };
    const host = await upsertHost(db, notifier, {
      name: "Persistent Host",
    });
    notifyHost.mockClear();

    await updateHost(db, notifier, host.id, {
      destroyedAt: 456,
    });

    expect(notifyHost).toHaveBeenCalledWith(host.id, ["host-disconnected"]);
    expect(await getHost(db, host.id)).toMatchObject({
      destroyedAt: 456,
    });
  });

  it("does not notify when updateHost only changes host metadata", async () => {
    const { db } = await setup();
    const notifyHost = vi.fn();
    const notifier = {
      notifyEnvironment() {},
      notifyHost,
      notifyProject() {},
      notifySystem() {},
      notifyThread() {},
    };
    const host = await upsertHost(db, notifier, {
      name: "Persistent Host",
    });
    notifyHost.mockClear();

    await updateHost(db, notifier, host.id, {
      name: "Persistent Host Renamed",
    });

    expect(notifyHost).not.toHaveBeenCalled();
  });
});
