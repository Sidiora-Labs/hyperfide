import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { inspectHyperfide } from "./hyperfide-status.js";

describe("Hyperfide binary inspection", () => {
  it("verifies a fake binary and reads the repository index", async () => {
    const root = await mkdtemp(join(tmpdir(), "hyperfide-status-"));
    try {
      const source = '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "hyperfide 22"; else echo \'{"symbols":42,"stale":false}\'; fi\n';
      await writeFile(join(root, "cg"), source, { mode: 0o755 });
      await mkdir(join(root, ".codegraph"));
      const result = await inspectHyperfide(root, { PATH: "" });
      expect(result).toMatchObject({ ok: true, version: "hyperfide 22", digest: createHash("sha256").update(source).digest("hex"), index: { symbols: 42, stale: false } });
      expect((await inspectHyperfide(root, { HYPERFIDE_BIN: join(root, "missing") })).ok).toBe(false);
      await mkdir(join(root, "bin"));
      await writeFile(join(root, "bin", "hyperfide"), source, { mode: 0o755 });
      const other = join(root, "other");
      await mkdir(other);
      expect((await inspectHyperfide(other, { PATH: join(root, "bin") })).version).toBe("hyperfide 22");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("reports missing and non-executable binaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "hyperfide-missing-"));
    try {
      expect(await inspectHyperfide(root, { PATH: "" })).toMatchObject({ path: null, version: null, digest: null, ok: false });
      await writeFile(join(root, "cg"), "not executable");
      expect((await inspectHyperfide(root, { PATH: "" })).ok).toBe(false);
      await writeFile(join(root, "bad"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      expect((await inspectHyperfide(root, { HYPERFIDE_BIN: "bad" })).ok).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
