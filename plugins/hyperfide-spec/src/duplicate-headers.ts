import { parseKvx } from "./kvx.js";

/** Validate specs with the same parser used by the spec read model. */
export function assertUniqueTaskHeaders(
  specs: Iterable<{ path: string; text: string }>,
): void {
  for (const spec of specs) {
    try {
      parseKvx(spec.text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message.replace(/^Duplicate KVX section task\./, "Duplicate task header task.")} in ${spec.path}`,
      );
    }
  }
}
