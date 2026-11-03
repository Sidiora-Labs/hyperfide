import {
  experimental_defineHostEntry,
  type ExperimentalHostWorkerLease,
} from "@hyperfide/plugin-sdk/host";
import { slicesHostContract } from "./contract.ts";
import { SlicesProvider, type SliceState } from "./provider.ts";
import { NativeSlicesProvider } from "./native-provider.ts";
const retained = new Map<
  string,
  { dataDir: string; sliceId: string; lease: ExperimentalHostWorkerLease }
>();
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
  dispose: async () => {
    for (const value of retained.values()) {
      try {
        await new NativeSlicesProvider(value.dataDir).detach(value.sliceId);
      } finally {
        await value.lease.dispose();
      }
    }
    retained.clear();
  },
  handlers: {
    nativeCapabilities: (_input, context) =>
      new NativeSlicesProvider(
        context.experimental_paths.dataDir,
      ).capabilities(),
    createNative: async (input, context) => {
      const dataDir = context.experimental_paths.dataDir;
      const result = await new NativeSlicesProvider(dataDir).create(
        input,
        input.thread,
      );
      const key = dataDir + "/" + result.sliceId;
      if (input.mode === "VIRTUAL" && !retained.has(key))
        retained.set(key, {
          dataDir,
          sliceId: result.sliceId,
          lease: context.experimental_retainWorker(),
        });
      return result;
    },
    finishNative: (input, context) =>
      new NativeSlicesProvider(context.experimental_paths.dataDir).finish(
        input.sliceId,
      ),
    metricsNative: (input, context) =>
      new NativeSlicesProvider(context.experimental_paths.dataDir).metrics(
        input.sliceId,
      ),
    detachNative: async (input, context) => {
      const result = await new NativeSlicesProvider(
        context.experimental_paths.dataDir,
      ).detach(input.sliceId);
      const key = context.experimental_paths.dataDir + "/" + input.sliceId;
      await retained.get(key)?.lease.dispose();
      retained.delete(key);
      return result;
    },
    detailNative: (input, context) =>
      new NativeSlicesProvider(context.experimental_paths.dataDir).detail(
        input.sliceId,
      ),
    discardNative: async (input, context) => {
      await new NativeSlicesProvider(
        context.experimental_paths.dataDir,
      ).discard(input.sliceId);
      const key = context.experimental_paths.dataDir + "/" + input.sliceId;
      await retained.get(key)?.lease.dispose();
      retained.delete(key);
      return { removed: true };
    },
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

export { serveNativeVirtualDaemon } from "./native-provider.ts";
