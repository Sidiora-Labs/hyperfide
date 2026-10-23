import type { PluginMachineProviderDefinition } from '@hyperfide/plugin-sdk/machine-provider';
import { MachineProviderError, type CredentialResolver, type SandboxMachineOps } from './machine-ops.js';

export function machineProvider(ops: SandboxMachineOps, resolve: CredentialResolver, region: () => Promise<string>): PluginMachineProviderDefinition {
  const resourceId = (resource: unknown): string => {
    if (typeof resource !== 'object' || resource === null || !('id' in resource) || typeof resource.id !== 'string') throw new MachineProviderError('Invalid Blaxel resource', 'invalid-resource');
    return resource.id;
  };
  return {
    id: ops.providerId, displayName: 'Blaxel', description: 'Run a machine in a Blaxel sandbox', icon: 'server', ephemeral: true,
    async availability() {
      try {
        const credentials = await resolve();
        return credentials?.apiKey.trim() && credentials.workspace.trim() ? { status: 'available' } : { status: 'setup-required', message: 'Configure Blaxel API key and workspace in plugin settings' };
      } catch { return { status: 'setup-required', message: 'Could not resolve Blaxel credentials' }; }
    },
    async create(context) {
      // Persist allocation intent before making the remote call for crash cleanup.
      await context.checkpoint({ id: context.key });
      const machine = await ops.create({ name: context.key, region: await region() });
      await context.checkpoint({ id: machine.id });
      return { status: 'created', name: machine.id, resource: { id: machine.id } };
    },
    async remove(context) {
      try { await (await ops.connect(resourceId(context.resource))).destroy(); }
      catch (error) { if (!(error instanceof MachineProviderError) || !/NotFound/.test(error.providerClass)) throw error; }
      return { status: 'removed' };
    },
    async reconcileCleanup(context) {
      try { await (await ops.connect(context.key)).destroy(); }
      catch (error) { if (!(error instanceof MachineProviderError) || !/NotFound/.test(error.providerClass)) throw error; }
      return { status: 'removed' };
    },
    async suspend() { throw new MachineProviderError('Blaxel suspend is unsupported', 'unsupported'); },
    async resume() { throw new MachineProviderError('Blaxel resume is unsupported', 'unsupported'); },
  };
}
