import { createMachineOps, type CredentialResolver } from './machine-ops.ts';
import { blaxelSdkFactory } from './sdk.ts';

export async function runLiveSmoke(resolve?: CredentialResolver): Promise<void> {
  if (!resolve) throw new Error('Live smoke requires an explicit plugin-settings credential resolver');
  const machine = await createMachineOps(resolve, blaxelSdkFactory).create({});
  try {
    const result = await machine.exec('node --version && git --version');
    if (result.exitCode !== 0) throw new Error('Blaxel live smoke command failed');
  } finally { await machine.destroy(); }
}
