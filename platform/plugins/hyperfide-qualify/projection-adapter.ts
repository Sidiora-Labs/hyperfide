// Local integration seam until Run task exposes its managed environment provider.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
export const runBinary = promisify(execFile);
export interface ManagedEnvironment { id: string; path: string; variables: NodeJS.ProcessEnv; release(): Promise<void> }
export interface QualificationAdapter {
  binary: string;
  repositoryKey(repository: string): Promise<string>;
  task(repository: string, feature: string, task: string): Promise<{verify_cmd: string}>;
  environment(repository: string, lane: string): Promise<ManagedEnvironment>;
}
export function createProjectionAdapter(binary = process.env.HYPERFIDE_BINARY ?? 'hyperfide'): QualificationAdapter {
  return {
    binary,
    async repositoryKey(repository) {
      const result = await runBinary('git', ['rev-parse', '--git-common-dir'], {cwd: repository});
      return realpath(resolve(repository, result.stdout.trim()));
    },
    async task(repository, feature, task) {
      if (!/^[\w-]+$/.test(feature)) throw new Error('Invalid feature');
      const text = await readFile(join(repository, 'spec', feature, 'spec.kvx'), 'utf8');
      const section = text.split(/^\[task\./m).slice(1).find(s => s.startsWith(`${task}]`))?.split(/^\[/m)[0];
      const value = section?.match(/^verify_cmd\s*=\s*("(?:[^"\\]|\\.)*")\s*$/m)?.[1];
      if (!value) throw new Error(`Missing verify_cmd for ${feature}/${task}`);
      return {verify_cmd: JSON.parse(value)};
    },
    async environment(repository, lane) {
      const root = await mkdtemp(join(tmpdir(), 'hyperfide-qualify-'));
      const path = join(root, 'worktree');
      try {
        await runBinary('git', ['worktree', 'add', '--detach', path, 'HEAD'], {cwd: repository});
        const bin = join(root, 'bin');
        await mkdir(bin);
        await symlink(process.execPath, join(bin, 'node'));
        await writeFile(join(bin, 'pnpm'), '#!/bin/sh\nexec corepack pnpm@9.15.0 "$@"\n', {mode: 0o755});
        return {id: `hyperfide-worktree-${lane}`, path,
          variables: {...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ''}`},
          async release() {
            await runBinary('git', ['worktree', 'remove', '--force', path], {cwd: repository});
            await rm(root, {recursive: true, force: true});
          }};
      } catch (error) {
        await rm(root, {recursive: true, force: true});
        await runBinary('git', ['worktree', 'prune'], {cwd: repository});
        throw error;
      }
    }
  };
}
