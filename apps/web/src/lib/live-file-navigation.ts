import type { ExperimentalFileLocation } from "@hyperfide/plugin-sdk";
export {
  normalizeExperimentalFileOpenOptions,
  normalizeExperimentalLiveFileTarget,
} from "@hyperfide/plugin-sdk/internal/file-navigation-validation";
import type { FilePreviewLineRange } from "@hyperfide/client-core";

export function getExperimentalFileLocationStart(
  location: ExperimentalFileLocation | null,
): { columnNumber: number | null; lineNumber: number | null } {
  if (location === null) return { columnNumber: null, lineNumber: null };
  if (location.kind === "line") {
    return { columnNumber: location.column, lineNumber: location.line };
  }
  return { columnNumber: null, lineNumber: location.startLine };
}

export function toFilePreviewLineRange(
  location: ExperimentalFileLocation | null,
): FilePreviewLineRange | null {
  if (location === null) return null;
  return {
    startLineNumber:
      location.kind === "line" ? location.line : location.startLine,
    endLineNumber: location.kind === "line" ? location.line : location.endLine,
  };
}

export function getFileBasename(path: string): string {
  const normalizedPath = path.replace(/[\\/]+$/u, "");
  return normalizedPath.split(/[\\/]/u).at(-1) ?? path;
}
