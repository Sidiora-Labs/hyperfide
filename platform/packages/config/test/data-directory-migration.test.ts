import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimeDataDir } from "../src/runtime.js";

const homes: string[] = [];
function fixture() {
  const homeDir = mkdtempSync(join(tmpdir(), "hyperfide-migration-"));
  homes.push(homeDir);
  const legacyDir = join(homeDir, String.fromCharCode(46, 98, 98));
  mkdirSync(legacyDir);
  writeFileSync(join(legacyDir, "sentinel"), "persisted data");
  return { homeDir, legacyDir, dataDir: join(homeDir, ".hyperfide") };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
describe("data directory migration", () => {
  it("moves existing data once and reports the move", () => {
    const { homeDir, legacyDir, dataDir } = fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveRuntimeDataDir({ homeDir, mode: "prod", env: {} })).toBe(
      dataDir,
    );
    expect(existsSync(legacyDir)).toBe(false);
    expect(readFileSync(join(dataDir, "sentinel"), "utf8")).toBe(
      "persisted data",
    );
    resolveRuntimeDataDir({ homeDir, mode: "prod", env: {} });
    expect(log).toHaveBeenCalledExactlyOnceWith(
      `Hyperfide migrated data from ${legacyDir} to ${dataDir}`,
    );
  });
  it("preserves both directories when the destination exists", () => {
    const { homeDir, legacyDir, dataDir } = fixture();
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, "sentinel"), "new data");
    resolveRuntimeDataDir({ homeDir, mode: "prod", env: {} });
    expect(readFileSync(join(dataDir, "sentinel"), "utf8")).toBe("new data");
    expect(existsSync(legacyDir)).toBe(true);
  });
  it("does not migrate when an explicit data directory is configured", () => {
    const { homeDir, legacyDir, dataDir } = fixture();
    const custom = join(homeDir, "custom");
    expect(
      resolveRuntimeDataDir({
        homeDir,
        mode: "prod",
        env: { HYPERFIDE_DATA_DIR: custom },
      }),
    ).toBe(custom);
    expect(existsSync(legacyDir)).toBe(true);
    expect(existsSync(dataDir)).toBe(false);
  });
});
