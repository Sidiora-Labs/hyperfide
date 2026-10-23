import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchArchive, frpArchiveFor } from "../src/binary.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, rename: vi.fn(original.rename) };
});

vi.mock("../src/binary.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/binary.js")>();
  return { ...original, fetchArchive: vi.fn(), frpArchiveFor: vi.fn() };
});

const bytes = new Uint8Array([1, 2, 3, 4]);
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "frp-cache-race-"));
  vi.stubEnv("BB_FRP_CACHE_DIR", dir);
  vi.resetModules();
  vi.mocked(frpArchiveFor).mockReturnValue({
    fileName: "fixture.zip",
    format: "zip",
    binaryName: "frpc.exe",
    member: "fixture/frpc.exe",
    url: "https://example.test/fixture.zip",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  vi.mocked(fetchArchive).mockResolvedValue(bytes);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

it.each([true, false])(
  "accepts a competing cache publisher only when its archive is valid: %s",
  async (valid) => {
    const failure = Object.assign(new Error("rename denied"), {
      code: "EPERM",
    });
    vi.mocked(fs.rename).mockImplementationOnce(
      async (_source, destination) => {
        await fs.writeFile(destination, valid ? bytes : new Uint8Array([0]));
        throw failure;
      },
    );
    const { cachedDownload } = await import("../src/testing/frp-fixture.js");
    const download = cachedDownload("win32", "x64");
    const result = download("https://example.test/fixture.zip");
    if (valid) {
      await expect(result).resolves.toEqual(bytes);
    } else {
      await expect(result).rejects.toBe(failure);
    }
    expect(await fs.readdir(dir)).toEqual(["fixture.zip"]);
  },
);
