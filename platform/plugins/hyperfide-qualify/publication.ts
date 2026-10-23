import { openQualifyStorage, publicationStore } from './storage';
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { closureView, waveSummary } from "../hyperfide-spec/wave-detail";
import type {
  PublicationAsks,
  WaveAuthority,
} from "../hyperfide-spec/wave-authority";
import type { WavePullRequest } from "../github/wave-publication";
import { createWaveAuthority } from "../hyperfide-spec/wave-authority";
import { publicationAsks } from "./publication-asks";
import { binaryCommand } from "../hyperfide-spec/src/reader";
import type { AskBridge } from "../hyperfide-asks/src/bridge";

const exec = promisify(execFile);
const gitEnvironment = () => ({
  ...process.env,
  GIT_ALLOW_PROTOCOL: "file",
  GIT_TERMINAL_PROMPT: "0",
});
export interface Publication {
  feature: string;
  wave: number;
  branch: string;
  base: string;
  baseBranch: string;
  head: string;
  remote: string;
  summary: string;
  snapshot: string;
  binding: string;
  ask: string;
  pushed: boolean;
  pr?: string;
}
export interface PublicationStore {
  get(key: string): Promise<Publication | undefined>;
  put(key: string, value: Publication): Promise<void>;
}
export interface PublicationHost {
  repository: string;
  authority: WaveAuthority;
  asks: PublicationAsks;
  store: PublicationStore;
  pullRequest?: (wave: WavePullRequest) => Promise<{ url: string }>;
}
export function createPublicationHost(input: Parameters<typeof createWaveAuthority>[0] & {
  asks: AskBridge;
  binary?: string;
  store: PublicationStore;
  pullRequest?: PublicationHost["pullRequest"];
}): PublicationHost {
  return {
    repository: input.repository,
    authority: createWaveAuthority(input),
    asks: publicationAsks(input.repository, input.asks, binaryCommand(input.binary)),
    store: input.store,
    pullRequest: input.pullRequest,
  };
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identifier = (value: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value))
    throw new Error("Invalid publication identifier");
  return value;
};

export class WavePublication {
  private busy = false;
  constructor(private host: PublicationHost) {
    const previous = host.store;
    const use = async <T>(fn: (store: PublicationStore) => Promise<T>) => {
      const storage = await openQualifyStorage(host.repository);
      try { return await fn(publicationStore(storage)); } finally { storage.close(); }
    };
    this.host = Object.assign(Object.create(host) as PublicationHost, { store: {
      get: (key: string) => use(async store => {
        const saved = await store.get(key);
        if (saved) return saved;
        const old = await previous.get(key);
        if (old) await store.put(key, old);
        return old;
      }),
      put: (key: string, value: Publication) => use(store => store.put(key, value)),
    }});
  }
  private async git(...args: string[]) {
    return (
      await exec(
        "git",
        ["-c", "core.hooksPath=/dev/null", "-C", this.host.repository, ...args],
        { maxBuffer: 4 * 1024 * 1024, env: gitEnvironment() },
      )
    ).stdout.trim();
  }
  private async localRemote(remote: string) {
    if (!isAbsolute(remote))
      throw new Error("Publication requires an absolute local bare remote");
    const path = await realpath(remote);
    if (
      (await this.git(
        "--git-dir",
        path,
        "rev-parse",
        "--is-bare-repository",
      )) !== "true"
    )
      throw new Error("Remote must be bare");
    return path;
  }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("Publication already running");
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }
  async prepare(input: {
    feature: string;
    wave: number;
    base: string;
    baseBranch: string;
    remote: string;
  }) {
    return this.exclusive(async () => {
      identifier(input.feature);
      if (!Number.isSafeInteger(input.wave) || input.wave < 0)
        throw new Error("Invalid wave");
      await this.git("check-ref-format", "--branch", input.baseBranch);
      const key = `${input.feature}/${input.wave}`;
      const previous = await this.host.store.get(key);
      if (previous) return previous;
      const wave = await this.host.authority.read(input.feature, input.wave);
      if (wave.feature !== input.feature || wave.wave !== input.wave)
        throw new Error("Wrong wave snapshot");
      const closure = closureView(wave);
      if (!closure.ready) throw new Error(closure.blockers.join("; "));
      if (!(await this.host.asks.policy("permission")).blocks)
        throw new Error("Permission policy must block");
      const remote = await this.localRemote(input.remote);
      const base = await this.git(
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${input.base}^{commit}`,
      );
      const branch = `publication/${input.feature}/wave-${input.wave}`;
      const root = await mkdtemp(join(tmpdir(), "hyperfide-publication-"));
      const tree = join(root, "tree");
      let attached = false;
      let head: string;
      try {
        await this.git("worktree", "add", "-b", branch, tree, base);
        attached = true;
        for (const task of wave.tasks) {
          identifier(task.id);
          if (!/^[a-f0-9]{40,64}$/.test(task.commit))
            throw new Error("Expected immutable task commit");
          const taskHead = await this.git(
            "rev-parse",
            "--verify",
            `${task.commit}^{commit}`,
          );
          await exec(
            "git",
            [
              "-c",
              "core.hooksPath=/dev/null",
              "-C",
              tree,
              "merge",
              "--squash",
              "--",
              taskHead,
            ],
            { env: gitEnvironment() },
          );
          await exec(
            "git",
            [
              "-c",
              "core.hooksPath=/dev/null",
              "-C",
              tree,
              "commit",
              "--allow-empty",
              "-m",
              `${task.id}: ${task.title}\n\n[spec:${input.feature}/${task.id}]`,
            ],
            { env: gitEnvironment() },
          );
        }
        head = await this.git("rev-parse", `refs/heads/${branch}`);
      } catch (error) {
        if (attached) {
          await this.git("worktree", "remove", "--force", tree);
          attached = false;
          await this.git("branch", "-D", branch);
        }
        throw error;
      } finally {
        if (attached) await this.git("worktree", "remove", "--force", tree);
        await rm(root, { recursive: true, force: true });
      }
      const summary = waveSummary(wave);
      const snapshot = digest({ ...wave, asks: [] });
      const binding = digest({
        key,
        head,
        remote,
        branch,
        base,
        summary,
        snapshot,
      });
      const ask = await this.host.asks.raise({
        kind: "permission",
        question: `Push ${branch} at ${head} to ${remote}?`,
        binding,
        options: ["grant", "refuse"],
      });
      if (ask.kind !== "permission" || ask.binding !== binding)
        throw new Error("Invalid permission Ask");
      const publication: Publication = {
        ...input,
        base,
        branch,
        head,
        remote,
        summary,
        snapshot,
        binding,
        ask: ask.id,
        pushed: false,
      };
      await this.host.store.put(key, publication);
      return publication;
    });
  }
  async publish(feature: string, wave: number) {
    return this.exclusive(async () => {
      const key = `${feature}/${wave}`;
      const saved = await this.host.store.get(key);
      if (!saved) throw new Error("Prepare publication first");
      const publication = { ...saved };
      if (!publication.pushed) {
        const ask = await this.host.asks.get(publication.ask);
        if (
          ask.id !== publication.ask ||
          ask.kind !== "permission" ||
          ask.binding !== publication.binding ||
          ask.status !== "answered" ||
          ask.answer !== "grant" ||
          !ask.operator?.trim()
        )
          throw new Error("Operator permission grant required");
        const current = await this.host.authority.read(feature, wave);
        const closure = closureView(current, publication.ask);
        if (
          !closure.ready ||
          digest({ ...current, asks: [] }) !== publication.snapshot
        )
          throw new Error("Wave changed; publication requires new preparation");
        if (
          (await this.git("rev-parse", `refs/heads/${publication.branch}`)) !==
          publication.head
        )
          throw new Error("Publication branch changed");
        await this.localRemote(publication.remote);
        await this.git(
          "push",
          "--",
          publication.remote,
          `${publication.head}:refs/heads/${publication.branch}`,
        );
        publication.pushed = true;
        await this.host.store.put(key, publication);
      }
      if (this.host.pullRequest && !publication.pr) {
        const result = await this.host.pullRequest({
          feature,
          wave,
          branch: publication.branch,
          base: publication.baseBranch,
          summary: publication.summary,
        });
        publication.pr = result.url;
        await this.host.store.put(key, publication);
      }
      return publication;
    });
  }
}
