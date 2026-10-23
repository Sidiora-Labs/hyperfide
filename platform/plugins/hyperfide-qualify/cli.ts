import type { WavePublication } from "./publication";
import type { WaveAuthority } from "../hyperfide-spec/wave-authority";
import { closureView } from "../hyperfide-spec/wave-detail";

export function waveCommands(
  authority: WaveAuthority,
  publication: WavePublication,
) {
  return {
    closure: async (feature: string, wave: number) =>
      closureView(await authority.read(feature, wave)),
    prepare: (input: Parameters<WavePublication["prepare"]>[0]) =>
      publication.prepare(input),
    publish: (feature: string, wave: number) =>
      publication.publish(feature, wave),
  };
}

import type { StartLane } from './lanes';
export interface QualificationRpcClient { call(method: string, input: unknown): Promise<unknown> }
export const startLane = (client: QualificationRpcClient, input: StartLane) => client.call('start', input);
export const cancelLane = (client: QualificationRpcClient, id: string) => client.call('cancel', {id});
