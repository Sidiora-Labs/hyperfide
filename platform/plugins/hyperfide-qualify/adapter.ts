// Compose the spec model and the platform worktree provider for qualification.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { featureFromKvx } from '../hyperfide-spec/src/kvx.js';
import { createWorktree, removeWorktree } from '../environment-git-worktree/host/worktree.js';
export const runBinary = promisify(execFile);
export interface ManagedEnvironment { id: string; path: string; variables: NodeJS.ProcessEnv; release(): Promise<void> }
export interface QualificationAdapter {
  binary: string;
  repositoryKey(repository: string): Promise<string>;
  task(repository: string, feature: string, task: string): Promise<{verify_cmd: string}>;
  environment(repository: string, lane: string): Promise<ManagedEnvironment>;
}
export function createQualificationAdapter(binary = process.env.HYPERFIDE_BINARY ?? 'hyperfide'): QualificationAdapter {
  return {
    binary,
    async repositoryKey(repository) {
      const result = await runBinary('git', ['rev-parse', '--git-common-dir'], {cwd: repository});
      return realpath(resolve(repository, result.stdout.trim()));
    },
    async task(repository, feature, task) {
      if (!/^[\w-]+$/.test(feature)) throw new Error('Invalid feature');
      const text = await readFile(join(repository, 'spec', feature, 'spec.kvx'), 'utf8');
      const found = featureFromKvx(feature, text).tasks.find(item => item.id === task);
      if (!found?.verify_cmd) throw new Error(`Missing verify_cmd for ${feature}/${task}`);
      return {verify_cmd: found.verify_cmd};
    },
    async environment(repository, lane) {
      const root = await mkdtemp(join(tmpdir(), 'hyperfide-qualify-'));
      const path = join(root, 'worktree');
      let created = false;
      try {
        await createWorktree({sourcePath: repository, targetPath: path, completionPath: join(root, 'complete'), ownWorktreesRoot: root, branchName: `hyperfide-qualify-${lane}`, baseBranch: 'HEAD', branchMode: 'reset'});
        created = true;
        const bin = join(root, 'bin');
        await mkdir(bin);
        await symlink(process.execPath, join(bin, 'node'));
        await writeFile(join(bin, 'pnpm'), '#!/bin/sh\nexec corepack pnpm@9.15.0 "$@"\n', {mode: 0o755});
        return {id: `hyperfide-worktree-${lane}`, path,
          variables: {...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ''}`},
          async release() {
            await removeWorktree({path});
            await runBinary('git', ['branch', '-D', `hyperfide-qualify-${lane}`], {cwd: repository});
            await rm(root, {recursive: true, force: true});
          }};
      } catch (error) {
        try {
          await removeWorktree({path});
          if (created) await runBinary('git', ['branch', '-D', `hyperfide-qualify-${lane}`], {cwd: repository});
        } finally {
          await rm(root, {recursive: true, force: true});
        }
        throw error;
      }
    }
  };
}
