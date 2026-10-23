import { defineSplit } from "@/lib/define-split";
import { DiffLoadingSkeleton } from "./code-loading-skeletons";
import type { HyperfideDiffProps } from "./code-rendering";

export const HyperfideDiffSplit = defineSplit<HyperfideDiffProps>({
  id: "hyperfide-diff",
  load: () => import("./HyperfideDiff").then((module) => module.default),
  loading: () => <DiffLoadingSkeleton />,
  tier: "intent",
});
