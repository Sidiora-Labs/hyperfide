import type { PluginHosts, PluginRpc } from '@hyperfide/plugin-sdk';
import { boardContract } from './contract.js';

export default function boardPlugin(api: { hosts: PluginHosts; rpc: PluginRpc }) {
  const host = api.hosts.experimental_client({ contract: boardContract });
  api.rpc.register(boardContract, {
    boardTasks: input => host.call('boardTasks', input, { hostId: input.hostId }),
    boardTask: input => host.call('boardTask', input, { hostId: input.hostId }),
    boardAction: input => host.call('boardAction', input, { hostId: input.hostId }),
  });
}
