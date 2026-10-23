/** Reject repeated task sections within each spec, preserving independent feature ids. */
export function assertUniqueTaskHeaders(
  specs: Iterable<{ path: string; text: string }>,
): void {
  for (const spec of specs) {
    const seen = new Set<string>();
    for (const match of spec.text.matchAll(
      /^\s*\[task\.([^\]\r\n]+)\]\s*(?:#.*)?$/gm,
    )) {
      const id = match[1].trim();
      if (seen.has(id))
        throw new Error(`Duplicate task header task.${id} in ${spec.path}`);
      seen.add(id);
    }
  }
}
