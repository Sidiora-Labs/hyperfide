import { PluginReplacementSlot } from "@/components/plugin/PluginReplacementSlot";
import { defineSplit } from "@/lib/define-split";
import { SourceLoadingSkeleton } from "./code-loading-skeletons";
import { useSourceCodeRendererReplacement } from "./codeRendererProvider";
import {
  DEFAULT_CODE_OVERFLOW,
  type HyperfideSourceCodeProps,
} from "./code-rendering";

const SOURCE_CODE_RENDERER_SLOT_KIND = "sourceCodeRenderer";

export const HyperfideSourceCodeSplit = defineSplit<HyperfideSourceCodeProps>({
  id: "hyperfide-source-code",
  load: () => import("./HyperfideSourceCode").then((module) => module.default),
  loading: () => <SourceLoadingSkeleton />,
  tier: "intent",
});

interface SourceCodeHostProps extends Omit<
  HyperfideSourceCodeProps,
  "overflow" | "highlightedLines"
> {
  overflow?: HyperfideSourceCodeProps["overflow"];
  highlightedLines?: HyperfideSourceCodeProps["highlightedLines"];
}

export function SourceCodeHost({
  content,
  path,
  cacheKey,
  overflow = DEFAULT_CODE_OVERFLOW,
  highlightedLines = null,
  className,
  scrollToHighlightedLines,
  onSelectionAddToChat,
}: SourceCodeHostProps) {
  const replacement = useSourceCodeRendererReplacement();

  const original = (
    <HyperfideSourceCodeSplit
      content={content}
      path={path}
      cacheKey={cacheKey}
      overflow={overflow}
      highlightedLines={highlightedLines}
      className={className}
      scrollToHighlightedLines={scrollToHighlightedLines}
      onSelectionAddToChat={onSelectionAddToChat}
    />
  );

  return (
    <PluginReplacementSlot
      replacement={replacement}
      original={original}
      slotKind={SOURCE_CODE_RENDERER_SLOT_KIND}
    >
      {(slot, BoundOriginal) => (
        <div className={className}>
          <slot.component
            content={content}
            path={path}
            overflow={overflow}
            highlightedLines={highlightedLines}
            Original={BoundOriginal}
          />
        </div>
      )}
    </PluginReplacementSlot>
  );
}
