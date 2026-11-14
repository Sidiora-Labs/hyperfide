import { describe, expect, it } from "vitest";
import { checkpointDisplayState } from "./views/ui-state.js";

describe("source-control checkpoint display state", () => {
  it("keeps an unresolved host checkpoint explicitly unknown", () => {
    expect(
      checkpointDisplayState({
        hostUnresolved: true,
        pending: false,
        dirty: false,
        evidenceStage: "ACKNOWLEDGED",
      }),
    ).toBe("UNKNOWN");
  });

  it("shows upload and dirty states before receipt-backed stages", () => {
    expect(
      checkpointDisplayState({
        hostUnresolved: false,
        pending: true,
        dirty: true,
        evidenceStage: "ACKNOWLEDGED",
      }),
    ).toBe("UPLOADING");
    expect(
      checkpointDisplayState({
        hostUnresolved: false,
        pending: false,
        dirty: true,
        evidenceStage: "ACKNOWLEDGED",
      }),
    ).toBe("DIRTY");
  });
});
