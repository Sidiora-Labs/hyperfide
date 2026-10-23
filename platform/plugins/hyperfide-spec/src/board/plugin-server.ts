import type { PluginHosts, PluginRpc } from '@hyperfide/plugin-sdk';
import { boardContract } from './contract.js';

export default function boardPlugin(api: { hosts: PluginHosts; rpc: PluginRpc }) {
  const host = api.hosts.experimental_client({ contract: boardContract });
  api.rpc.register(boardContract, {
    tasks: input => host.call('tasks', input, { hostId: input.hostId }),
    action: input => host.call('action', input, { hostId: input.hostId }),
  });
}
