import { mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Values never enter RPC results, error details, or the Ask journal. */
export class NamedSecretStore {
  constructor(private directory = join(homedir(), ".hyperfide", "secrets")) {}
  async store(value: string): Promise<string> {
    if (!value || Buffer.byteLength(value) > 65536)
      throw new Error("Invalid secret value");
    const name = `ask-${randomUUID()}`;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = await open(join(this.directory, name), "wx", 0o600);
      try {
        await file.writeFile(value, "utf8");
      } finally {
        await file.close();
      }
      return name;
    } catch {
      throw new Error("Secret storage failed");
    }
  }
}
