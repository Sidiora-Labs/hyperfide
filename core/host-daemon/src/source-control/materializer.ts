import {
  SparseSourceMaterializer as Materializer,
  captureWorkspaceFile,
} from "@hyperfide/source-control/host";
import { hostSourceMetrics, type SourceMetrics } from "./metrics.js";
export {
  withWorkspaceParent,
  captureWorkspaceFile,
} from "@hyperfide/source-control/host";
export type { CapturedFile } from "@hyperfide/source-control/host";

export class SparseSourceMaterializer extends Materializer {
  private observedDirtyBytes = 0;
  readonly productMetrics: SourceMetrics;
  constructor(
    ...args: [
      ...ConstructorParameters<typeof Materializer>,
      productMetrics?: SourceMetrics,
    ]
  ) {
    super(args[0], args[1], args[2], args[3]);
    this.productMetrics =
      args[4] ??
      (args[1] as { productMetrics?: SourceMetrics }).productMetrics ??
      hostSourceMetrics;
  }
  async observeDirty(descriptor: Parameters<Materializer["reconcile"]>[0]) {
    const state = await this.journal.snapshot();
    let bytes = 0;
    for (const entry of state.entries) {
      if (entry.operation === "remove") continue;
      await this.client.assertAccess(descriptor, entry.path, true);
      try {
        bytes += (
          await captureWorkspaceFile(
            this.root,
            entry.path,
            descriptor.budgets.max_file_bytes,
          )
        ).bytes.length;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    this.productMetrics.adjustGauge(
      "dirtyBytes",
      bytes - this.observedDirtyBytes,
      { mode: descriptor.mode, status: "success", partition: "OVERLAY" },
    );
    this.observedDirtyBytes = bytes;
  }
  override async materialize(...args: Parameters<Materializer["materialize"]>) {
    const started = performance.now();
    const labels = {
      mode: args[0].mode,
      status: "success",
      partition: "OVERLAY",
    } as const;
    try {
      const result = await super.materialize(...args);
      this.productMetrics.increment(
        "materializationBytes",
        result.bytes,
        labels,
      );
      this.productMetrics.increment(
        "materializationFiles",
        result.files,
        labels,
      );
      this.productMetrics.record(
        "open",
        "success",
        performance.now() - started,
        0,
        labels,
      );
      return result;
    } catch (error) {
      this.productMetrics.record(
        "open",
        "rejected",
        performance.now() - started,
        0,
        { ...labels, status: "rejected" },
      );
      throw error;
    }
  }
  override async reconcile(...args: Parameters<Materializer["reconcile"]>) {
    await super.reconcile(...args);
    await this.observeDirty(args[0]);
  }
}
