import { experimental_defineHostEntry } from "@hyperfide/plugin-sdk/host";
import { slicesHostContract } from "./contract.ts";
import { SlicesProvider, type SliceState } from "./provider.ts";
const detail = (state: SliceState) => ({
  sliceId: state.id,
  snapshotChain: state.snapshots,
  fallbackReason: state.manifest.fallback_reason,
});
export function createSliceHandlers(binary: string, dataDir: string) {
  const service = new SlicesProvider(binary, dataDir);
  return {
    async create(input: Parameters<SlicesProvider["create"]>[0]) {
      const state = await service.create(input);
      return { sliceId: state.id, path: state.path };
    },
    async finish(input: { sliceId: string }) {
      return detail(await service.finish(input.sliceId));
    },
    async detail(input: { sliceId: string }) {
      return detail(await service.load(input.sliceId));
    },
    async discard(input: { sliceId: string }) {
      await service.discard(input.sliceId);
      return { removed: true };
    },
  };
}
export default experimental_defineHostEntry({
  contract: slicesHostContract,
  handlers: {
    create: (input, context) =>
      createSliceHandlers(
        process.env.HYPERFIDE_BINARY ?? "/usr/local/bin/hyperfide",
        context.experimental_paths.dataDir,
      ).create(input),
    finish: (input, context) =>
      createSliceHandlers(
        process.env.HYPERFIDE_BINARY ?? "/usr/local/bin/hyperfide",
        context.experimental_paths.dataDir,
      ).finish(input),
    detail: (input, context) =>
      createSliceHandlers(
        process.env.HYPERFIDE_BINARY ?? "/usr/local/bin/hyperfide",
        context.experimental_paths.dataDir,
      ).detail(input),
    discard: (input, context) =>
      createSliceHandlers(
        process.env.HYPERFIDE_BINARY ?? "/usr/local/bin/hyperfide",
        context.experimental_paths.dataDir,
      ).discard(input),
  },
});
