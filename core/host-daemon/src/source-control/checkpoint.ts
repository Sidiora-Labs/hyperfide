import { NativeWorkspaceCheckpoint as WorkspaceCheckpoint } from "@hyperfide/source-control/host";
import {
  SourceBudgetExceeded,
  hostSourceMetrics,
  type SourceMetrics,
} from "./metrics.js";
import type { SparseSourceMaterializer } from "./materializer.js";

export class NativeWorkspaceCheckpoint extends WorkspaceCheckpoint {
  private capturing = false;
  readonly productMetrics: SourceMetrics;
  constructor(
    ...args: [
      ...ConstructorParameters<typeof WorkspaceCheckpoint>,
      productMetrics?: SourceMetrics,
    ]
  ) {
    super(args[0], args[1], args[2], args[3]);
    this.productMetrics =
      args[4] ??
      (args[3] as SparseSourceMaterializer | undefined)?.productMetrics ??
      hostSourceMetrics;
  }
  override async checkpoint(
    ...args: Parameters<WorkspaceCheckpoint["checkpoint"]>
  ) {
    if (this.capturing)
      throw new SourceBudgetExceeded("concurrent_requests", 1);
    this.capturing = true;
    const started = performance.now(),
      labels = {
        mode: args[0].mode,
        status: "success",
        partition: "OVERLAY",
      } as const;
    this.productMetrics.adjustGauge("transferQueueDepth", 1, labels);
    try {
      const result = await super.checkpoint(...args);
      const materializer = this.materializer as
        | SparseSourceMaterializer
        | undefined;
      if (materializer?.observeDirty)
        await materializer.observeDirty(result.workspace);
      this.productMetrics.record(
        "checkpoint",
        "success",
        performance.now() - started,
        0,
        labels,
      );
      return result;
    } catch (error) {
      this.productMetrics.record(
        "checkpoint",
        "unknown",
        performance.now() - started,
        0,
        { ...labels, status: "unknown" },
      );
      throw error;
    } finally {
      this.capturing = false;
      this.productMetrics.adjustGauge("transferQueueDepth", -1, labels);
    }
  }
}
