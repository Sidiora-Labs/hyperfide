import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ServerCredentials { username: string; password: string }
export interface CredentialEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
export function basicAuthorization(credentials: ServerCredentials): string {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, "utf8").toString("base64")}`;
}

/** Credentials on disk are exclusively safeStorage ciphertext; unavailable encryption is session-only. */
export class ServerCredentialStore {
  private readonly session = new Map<string, ServerCredentials>();
  private encrypted: Record<string, string> = {};
  constructor(private readonly path: string, private readonly encryption: CredentialEncryption) {}
  async load(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      this.encrypted = Object.fromEntries(
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string") : [],
      );
    } catch { this.encrypted = {}; }
  }
  get(url: string): ServerCredentials | undefined {
    const origin = new URL(url).origin;
    const current = this.session.get(origin);
    if (current) return current;
    const ciphertext = this.encrypted[origin];
    if (!ciphertext || !this.encryption.isEncryptionAvailable()) return undefined;
    try {
      const value: unknown = JSON.parse(this.encryption.decryptString(Buffer.from(ciphertext, "base64")));
      if (typeof value === "object" && value !== null && "username" in value && "password" in value && typeof value.username === "string" && typeof value.password === "string") {
        return { username: value.username, password: value.password };
      }
    } catch { /* Locked or unreadable keychain: prompt again. */ }
    return undefined;
  }
  async set(url: string, credentials: ServerCredentials, remember: boolean): Promise<void> {
    const origin = new URL(url).origin;
    this.session.set(origin, credentials);
    delete this.encrypted[origin];
    if (remember && this.encryption.isEncryptionAvailable()) {
      this.encrypted[origin] = this.encryption.encryptString(JSON.stringify(credentials)).toString("base64");
    }
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(`${this.path}.tmp`, JSON.stringify(this.encrypted), { mode: 0o600 });
    await rename(`${this.path}.tmp`, this.path);
  }
}

/** A repeated browser challenge means the previous answer failed. */
export class ServerLoginDecision {
  private readonly attempted = new Set<string>();
  constructor(private readonly get: (origin: string) => ServerCredentials | undefined,
    private readonly prompt: (origin: string) => Promise<ServerCredentials | null>) {}
  async answer(origin: string): Promise<ServerCredentials | null> {
    const saved = this.attempted.has(origin) ? undefined : this.get(origin);
    this.attempted.add(origin);
    return saved ?? this.prompt(origin);
  }
}
