import { WavePublication, type PublicationHost } from "./publication";
import { waveDetail } from "../hyperfide-spec/wave-detail";
import type { HumanJob, Operator } from "../hyperfide-spec/closure-projection";

// Projection host adapter: the real plugin host supplies authority, Asks and storage.
export interface ClosurePluginHost extends PublicationHost {
  operator(): Promise<Operator>;
  rpc: {
    register(name: string, handler: (input: any) => Promise<unknown>): void;
  };
}
export default function registerWaveClosure(host: ClosurePluginHost) {
  const detail = waveDetail(host.authority);
  const publication = new WavePublication(host);
  host.rpc.register(
    "hyperfide-qualify.wave",
    (input: { feature: string; wave: number }) =>
      detail.read(input.feature, input.wave),
  );
  host.rpc.register(
    "hyperfide-qualify.mark",
    async (input: { feature: string; wave: number; job: HumanJob }) =>
      detail.mark(input.feature, input.wave, input.job, await host.operator()),
  );
  host.rpc.register("hyperfide-qualify.prepare", (input) =>
    publication.prepare(input),
  );
  host.rpc.register(
    "hyperfide-qualify.publish",
    (input: { feature: string; wave: number }) =>
      publication.publish(input.feature, input.wave),
  );
  return publication;
}
