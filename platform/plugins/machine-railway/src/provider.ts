import type { PluginMachineProviderDefinition, PluginMachineProviderResource } from "@hyperfide/plugin-sdk/machine-provider";
import { MachineProviderError, type CredentialsResolver, type SandboxMachineOps } from "./machine-ops.js";
export interface AllocationStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}
interface Resource { id: string | null; checkpoint: string | null; key: string }
function parse(value: PluginMachineProviderResource): Resource {
  if (typeof value !== "object" || Array.isArray(value) || !("key" in value) || typeof value.key !== "string" || !("id" in value) || (value.id !== null && typeof value.id !== "string") || !("checkpoint" in value) || (value.checkpoint !== null && typeof value.checkpoint !== "string")) throw new MachineProviderError("Invalid Railway machine resource.", "invalid-resource");
  return { id: value.id, checkpoint: value.checkpoint, key: value.key };
}
export function createProvider(ops: SandboxMachineOps, resolve: CredentialsResolver, store: AllocationStore): PluginMachineProviderDefinition<undefined> {
  const storeKey = (key: string) => `railway/allocation/${key}`;
  const save = async (resource: Resource) => { await store.set(storeKey(resource.key), resource); return { ...resource }; };
  const remove = async (resource: Resource) => {
    if (resource.id) {
      try { await (await ops.connect(resource.id)).destroy(); }
      catch (error) { if (!(error instanceof MachineProviderError) || error.providerClass !== "SandboxNotFoundError") throw error; }
    }
    await save({ ...resource, id: null, checkpoint: null });
    return { status: "removed" as const };
  };
  return {
    id: ops.providerId, displayName: "Railway", description: "Run machines in Railway sandboxes.", icon: "train", ephemeral: true,
    async availability() {
      try { return await resolve() ? { status: "available" } : { status: "setup-required", message: "Configure Railway credentials in plugin settings." }; }
      catch { return { status: "unavailable", message: "Railway settings could not be resolved." }; }
    },
    async create(context) {
      const prior = await store.get<Resource>(storeKey(context.key));
      if (prior && !(prior.id === null && prior.checkpoint === null)) throw new MachineProviderError("Allocation already recorded; reconcile before retrying.", "allocation-pending");
      // Record intent before allocating: an interrupted create must never be reported cleaned up.
      await store.set(storeKey(context.key), { pending: true });
      const machine = await ops.create({ name: context.key });
      const resource = await save({ id: machine.id, checkpoint: null, key: context.key });
      await context.checkpoint(resource);
      return { status: "created", name: "Railway machine", resource };
    },
    async reconcileCleanup({ key }) {
      const stored = await store.get<Resource | { pending: true }>(storeKey(key));
      if (!stored) return { status: "removed" };
      if ("pending" in stored) return { status: "failed", message: "Railway allocation outcome is unresolved; inspect the environment before cleanup." };
      return remove(stored);
    },
    remove: ({ resource }) => remove(parse(resource)),
    async suspend(context) {
      const resource = parse(context.resource);
      if (!resource.id) return { resource: { ...resource } };
      let machine;
      try { machine = await ops.connect(resource.id); }
      catch (error) {
        if (resource.checkpoint && error instanceof MachineProviderError && error.providerClass === "SandboxNotFoundError") return { resource: await save({ ...resource, id: null }) };
        throw error;
      }
      const snapshot = resource.checkpoint ?? `hyperfide-${resource.id}`;
      await machine.checkpoint(snapshot);
      const saved = await save({ ...resource, checkpoint: snapshot });
      await context.checkpoint(saved);
      await machine.destroy();
      return { resource: await save({ ...resource, id: null, checkpoint: snapshot }) };
    },
    async resume(context) {
      const resource = parse(context.resource);
      if (resource.id) {
        try { await ops.connect(resource.id); return { resource: { ...resource } }; }
        catch (error) { if (!(error instanceof MachineProviderError) || error.providerClass !== "SandboxNotFoundError") throw error; }
      }
      if (!resource.checkpoint) throw new MachineProviderError("No saved Railway checkpoint.", "checkpoint-missing");
      const machine = await ops.create({ fromCheckpoint: resource.checkpoint, name: resource.key });
      const saved = await save({ ...resource, id: machine.id });
      await context.checkpoint(saved);
      return { resource: saved };
    },
  };
}
