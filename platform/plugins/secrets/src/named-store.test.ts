import { it, expect } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NamedSecretStore } from "./named-store.js";
it("stores unique references privately and returns only the name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hyperfide-secret-"));
  try {
    const store = new NamedSecretStore(join(dir, "vault"));
    const value = crypto.randomUUID();
    const name = await store.store(value);
    expect(name.includes(value)).toBe(false);
    expect((await readFile(join(dir, "vault", name), "utf8")) === value).toBe(
      true,
    );
    expect((await stat(join(dir, "vault", name))).mode & 0o777).toBe(0o600);
    expect(await store.store(value)).not.toBe(name);
    await expect(store.store("")).rejects.toThrow("Invalid secret value");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
