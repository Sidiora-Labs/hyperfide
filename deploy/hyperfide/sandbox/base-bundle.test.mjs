import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {revisionLayout} from './layout.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
const node = process.execPath;

test('base bundle cache is scoped to both main tip and checkpoint commit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperfide-base-bundle-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const mapping = path.join(root, 'spec/hyperfide-source-control/repository-layout.json');
  const configFile = path.join(root, 'fleet.json');
  const commit = message => {
    fs.writeFileSync(path.join(root, 'state.txt'), `${message}\n`);
    git('add', '.');
    git('-c', 'user.name=Base Bundle Fixture', '-c', 'user.email=base-bundle@invalid', 'commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  const runBaseBundle = () => {
    const script = `import {baseBundle} from ${JSON.stringify(pathToFileURL(path.join(source, 'lib.mjs')).href)}; console.log(baseBundle(${JSON.stringify(baseCommit)}));`;
    const result = spawnSync(node, ['--input-type=module', '--eval', script], {
      env: {...process.env, HF_FLEET_CONFIG: configFile},
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  let baseCommit;
  try {
    git('init', '-q', '-b', 'main');
    fs.mkdirSync(path.dirname(mapping), {recursive: true});
    fs.writeFileSync(mapping, JSON.stringify({schema_version: 1, layout_generation: 'fixture-layout'}) + '\n');
    commit('first');
    const checkpointOne = commit('checkpoint one');
    commit('between checkpoints');
    baseCommit = commit('job base');
    const tip = commit('main tip');
    const common = {
      repo: root,
      mainBranch: 'main',
      checkpoint: 'fixture-checkpoint',
      paths: {bundles: 'bundles'},
      env: {token: 'HF_BASE_BUNDLE_TOKEN', environmentId: 'HF_BASE_BUNDLE_ENV', gatewayUrl: 'HF_BASE_BUNDLE_URL', gatewayKeys: 'HF_BASE_BUNDLE_KEYS'},
    };
    const writeConfig = checkpointCommit => {
      fs.writeFileSync(configFile, JSON.stringify({...common, checkpointCommit, checkpointLayout: revisionLayout(root, checkpointCommit)}) + '\n');
    };

    writeConfig(checkpointOne);
    const firstBundle = runBaseBundle();
    const checkpointTwo = git('rev-parse', `${tip}~2`);
    writeConfig(checkpointTwo);
    const secondBundle = runBaseBundle();

    assert.notEqual(firstBundle, secondBundle, 'changing checkpointCommit must select a different cache entry');
    assert.match(path.basename(firstBundle), new RegExp(`base-${tip.slice(0, 12)}-${checkpointOne.slice(0, 12)}\\.bundle$`));
    assert.match(path.basename(secondBundle), new RegExp(`base-${tip.slice(0, 12)}-${checkpointTwo.slice(0, 12)}\\.bundle$`));
    assert.equal(fs.existsSync(firstBundle), true);
    assert.equal(fs.existsSync(secondBundle), true);
    const firstVerification = execFileSync('git', ['-C', root, 'bundle', 'verify', firstBundle], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    const secondVerification = execFileSync('git', ['-C', root, 'bundle', 'verify', secondBundle], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    assert.match(firstVerification, new RegExp(checkpointOne));
    assert.match(secondVerification, new RegExp(checkpointTwo));
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
