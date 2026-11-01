import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {layoutContract, revisionLayout, validateLayoutCompatibility} from './layout.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
test('checkpoint layout producer, warm probe and stale provisioning use actual Git and filesystem state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperfide-layout-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const mapping = path.join(root, 'spec/hyperfide-source-control/repository-layout.json');
  const writeMapping = generation => fs.writeFileSync(mapping, JSON.stringify({schema_version: 1, layout_generation: generation}) + '\n');
  const commit = message => { git('add', '.'); git('-c', 'user.name=Layout Fixture', '-c', 'user.email=layout@invalid', 'commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  const run = (script, args, env = {}) => spawnSync(node, [path.join(source, script), ...args], {cwd: root, env: {...process.env, ...env}, encoding: 'utf8', timeout: 10000});
  try {
    git('init', '-q', '-b', 'main');
    fs.mkdirSync(path.dirname(mapping), {recursive: true});
    writeMapping('old-layout'); const old = commit('old layout');
    writeMapping('category-layout-v1'); const current = commit('current layout');
    const expected = revisionLayout(root, current);
    assert.deepEqual(validateLayoutCompatibility(root, expected), layoutContract(root));
    assert.throws(() => validateLayoutCompatibility(root, {...expected, layout_generation: 'old-layout'}), /LAYOUT_IMAGE_INCOMPATIBLE/);
    const args = [current, expected.layout_generation, expected.mapping_digest];
    let result = run('layout.mjs', ['probe', ...args]);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /LAYOUT_IMAGE_INCOMPATIBLE/);
    result = run('layout.mjs', ['stamp', ...args]); assert.equal(result.status, 0, result.stderr);
    const marker = path.join(root, '.git/hyperfide-prepared-layout.json'), original = fs.readFileSync(marker);
    for (let n = 0; n < 2; n++) {
      result = run('layout.mjs', ['probe', ...args]); assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(fs.readFileSync(marker), original);
    }
    fs.writeFileSync(path.join(root, 'ordinary.txt'), 'ordinary source edit\n'); commit('ordinary source');
    assert.deepEqual(revisionLayout(root, current), expected);
    assert.equal(run('layout.mjs', ['probe', ...args]).status, 0);
    fs.writeFileSync(marker, JSON.stringify({...expected, layout_generation: 'old-layout'}));
    result = run('layout.mjs', ['probe', ...args]); assert.notEqual(result.status, 0); assert.match(result.stderr, /LAYOUT_IMAGE_INCOMPATIBLE/);
    fs.writeFileSync(marker, original);
    const configFile = path.join(root, 'fleet.json');
    const config = {repo: root, workspace: '/work/hyperfide', mainBranch: 'main', checkpoint: 'fixture-checkpoint', checkpointCommit: old, paths: {ledger: 'ledger'}, env: {token: 'HF_LAYOUT_TEST_NO_TOKEN', environmentId: 'HF_LAYOUT_TEST_NO_ENV'}};
    fs.writeFileSync(configFile, JSON.stringify(config));
    const env = {HF_FLEET_CONFIG: configFile, HF_LAYOUT_TEST_NO_TOKEN: '', HF_LAYOUT_TEST_NO_ENV: ''};
    for (const value of [undefined, {...expected, checkpoint_commit: old}, {...expected, mapping_digest: 'sha256:' + '0'.repeat(64)}]) {
      const actual = {...config, checkpointLayout: value}; fs.writeFileSync(configFile, JSON.stringify(actual)); const before = fs.readFileSync(configFile);
      result = run('provision.mjs', ['pool', '1'], env);
      assert.notEqual(result.status, 0); assert.match(result.stderr, /LAYOUT_IMAGE_INCOMPATIBLE/); assert.doesNotMatch(result.stderr, /environment variable\(s\) not set|ERR_MODULE_NOT_FOUND/);
      assert.deepEqual(fs.readFileSync(configFile), before); assert.equal(fs.existsSync(path.join(root, 'ledger')), false);
    }
    result = run('provision.mjs', ['use', 'stale-checkpoint', old], env);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /LAYOUT_IMAGE_INCOMPATIBLE/);
    result = run('provision.mjs', ['use', 'fixture-checkpoint', current], env);
    assert.equal(result.status, 0, result.stderr);
    const recorded = JSON.parse(fs.readFileSync(configFile)); assert.deepEqual(recorded.checkpointLayout, expected);
    result = run('provision.mjs', ['pool', '1'], env);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /environment variable\(s\) not set/); assert.doesNotMatch(result.stderr, /LAYOUT_IMAGE_INCOMPATIBLE/);
    const workerFile = path.join(root, 'worker.json'), jobFile = path.join(root, 'job.json');
    fs.writeFileSync(workerFile, JSON.stringify({name: 'fixture-worker', checkpoint: 'fixture-checkpoint'}));
    fs.writeFileSync(jobFile, JSON.stringify({id: 'layout', kind: 'qualify', base: current}));
    result = run('run-job.mjs', [workerFile, jobFile], env);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /LAYOUT_IMAGE_INCOMPATIBLE/); assert.equal(fs.existsSync(path.join(root, 'ledger')), false);
    fs.writeFileSync(mapping, JSON.stringify({schema_version: 1, layout_generation: expected.layout_generation, changed_mapping: true}));
    assert.notDeepEqual(layoutContract(root), layoutContract(root, current));
    result = run('layout.mjs', ['probe', ...args]); assert.notEqual(result.status, 0); assert.match(result.stderr, /LAYOUT_IMAGE_INCOMPATIBLE/);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
