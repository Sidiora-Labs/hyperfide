import type { WavePublication } from "./publication";
import type { WaveAuthority } from "../hyperfide-spec/closure-projection";
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
