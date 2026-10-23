#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, openSync, closeSync, mkdtempSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
const execute = (cmd, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: 'inherit', ...options });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(Error(`${cmd} exited ${code}`)));
});
const tool = resolve('platform/tools/rename/apply.mjs');
const rules = JSON.parse(readFileSync('platform/tools/rename/map.json'));
const fixture = resolve('tests/hyperfide/cases/v22/fixtures/rename');
const run = async (mode, root) => {
  const reportPath = `${fixture}/report.json`;
  const fd = openSync(reportPath, 'w');
  try { await execute(process.execPath, [tool, mode, root], { stdio: ['ignore', fd, 'inherit'] }); }
  finally { closeSync(fd); }
  const report = JSON.parse(readFileSync(reportPath));
  rmSync(reportPath);
  return report;
};
rmSync(fixture, { recursive: true, force: true });
mkdirSync(fixture, { recursive: true });
try {
  await execute('git', ['init', '-q', fixture]);
  const textRules = rules.filter(r => r.kind !== 'path');
  const original = textRules.map(r => r.from + (r.from.endsWith('_') ? 'VALUE' : '')).join('\n') + '\n';
  writeFileSync(`${fixture}/sample.txt`, original);
  for (const rule of rules.filter(r => r.kind === 'path')) {
    mkdirSync(`${fixture}/${rule.from}`, { recursive: true });
    writeFileSync(`${fixture}/${rule.from}/content.txt`, original);
  }
  for (const skip of ['node_modules', 'dist', '.turbo', 'licenses']) {
    mkdirSync(`${fixture}/${skip}`);
    writeFileSync(`${fixture}/${skip}/skip.txt`, original);
  }
  writeFileSync(`${fixture}/pnpm-lock.yaml`, original);
  writeFileSync(`${fixture}/boundary.txt`, `before${rules.find(r => r.kind === 'identifier').from}after`);
  const legacy = String.fromCharCode(98, 98);
  const negative = ['c75f6e' + legacy + '-133d', 'd21a5a' + legacy + '-f0c5', '4f' + legacy + '-a011', 'toolu_123BbygRxABC', 'msg_1238BbzMYABC', 'b' + legacy + '-late', 'hobby rabbit abbr', ...rules.filter(r => r.kind !== 'path' && /^[A-Za-z]/.test(r.from)).map(r => 'x' + r.from + 'x')].join('\n');
  writeFileSync(`${fixture}/negative.txt`, negative);
  writeFileSync(`${fixture}/positive.ts`, `const PROJECT_IDS = { ${legacy}: "proj_${legacy}" }; PROJECT_IDS.${legacy}; const label = "Updating ${legacy} to 1.2.0; Reload ${legacy}; sign in to your ${legacy} account";\n`);
  writeFileSync(`${fixture}/command.sh`, `${legacy} dev\n`);
  writeFileSync(`${fixture}/package.json`, JSON.stringify({bin:{[legacy]:'./launcher'}}));
  await execute('git', ['-C', fixture, 'add', '-f', '.']);
  const dry = await run('--dry-run', fixture);
  assert.equal(readFileSync(`${fixture}/sample.txt`, 'utf8'), original);
  for (const kind of ['identifier', 'text', 'path']) assert(dry.rules.some(r => r.kind === kind && r.count > 0));
  const applied = await run('--apply', fixture);
  assert.deepEqual(applied, dry);
  const expected = textRules.map(r => r.from === legacy ? 'Hyperfide' : r.to + (r.from.endsWith('_') ? 'VALUE' : '')).join('\n') + '\n';
  assert.equal(readFileSync(`${fixture}/sample.txt`, 'utf8'), expected);
  for (const value of ['@hyperfide/', 'HYPERFIDE_TELEMETRY', '.hyperfide', 'hyperfide.dev', 'Hyperfide']) assert(expected.includes(value), value);
  assert.equal(readFileSync(`${fixture}/positive.ts`, 'utf8'), `const PROJECT_IDS = { hyperfide: "proj_${legacy}" }; PROJECT_IDS.hyperfide; const label = "Updating Hyperfide to 1.2.0; Reload Hyperfide; sign in to your Hyperfide account";\n`);
  assert.equal(readFileSync(`${fixture}/command.sh`, 'utf8'), 'hyperfide-platform dev\n');
  assert.equal(readFileSync(`${fixture}/negative.txt`, 'utf8'), negative);
  assert.deepEqual(JSON.parse(readFileSync(`${fixture}/package.json`)), {bin:{'hyperfide-platform':'./launcher'}});
  assert.equal(readFileSync(`${fixture}/boundary.txt`, 'utf8'), `before${rules.find(r => r.kind === 'identifier').from}after`);
  for (const rule of rules.filter(r => r.kind === 'path')) {
    assert(!existsSync(`${fixture}/${rule.from}`));
    let destination = rule.from;
    for (const rename of rules.filter(r => r.kind === 'path').sort((a,b) => b.from.split('/').length - a.from.split('/').length)) {
      if (destination === rename.from || destination.startsWith(rename.from + '/')) destination = rename.to + destination.slice(rename.from.length);
    }
    assert.equal(readFileSync(`${fixture}/${destination}/content.txt`, 'utf8'), expected);
  }
  for (const skip of ['node_modules', 'dist', '.turbo', 'licenses']) assert.equal(readFileSync(`${fixture}/${skip}/skip.txt`, 'utf8'), original);
  assert.equal(readFileSync(`${fixture}/pnpm-lock.yaml`, 'utf8'), original);
  const second = await run('--apply', fixture);
  assert(second.rules.every(r => r.count === 0));
  assert.deepEqual(second.files, {});
  assert.deepEqual(second.renames, []);
  const platform = await run('--dry-run', resolve('platform'));
  for (const kind of ['identifier', 'text', 'path']) assert(platform.rules.some(r => r.kind === kind && r.count > 0), kind);
  const scratch = mkdtempSync(resolve(tmpdir(), 'hyperfide-rename-'));
  try {
    const trackedPath = resolve(fixture, 'tracked-list');
    const trackedFd = openSync(trackedPath, 'w');
    try { await execute('git', ['ls-files', '-z', 'platform'], {stdio:['ignore', trackedFd, 'inherit']}); } finally { closeSync(trackedFd); }
    const tracked = readFileSync(trackedPath, 'utf8').split('\0').filter(Boolean);
    rmSync(trackedPath);
    const ts = createRequire(resolve('platform/package.json'))('typescript');
    const baseline = new Map();
    const diagnostics = (name, text) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true).parseDiagnostics.map(d => `${d.code}:${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    for (const file of tracked) {
      const name = file.slice('platform/'.length);
      if (name.split('/').some(p => ['node_modules', 'dist', '.turbo', 'licenses'].includes(p) || p.startsWith('.env'))) continue;
      mkdirSync(dirname(resolve(scratch, name)), {recursive:true});
      copyFileSync(file, resolve(scratch, name));
      if (/\.(ts|tsx|js|mjs)$/.test(name)) baseline.set(name, diagnostics(name, readFileSync(file, 'utf8')));
    }
    await execute('git', ['init', '-q', scratch]);
    await execute('git', ['-C', scratch, 'add', '-f', '.']);
    const changed = await run('--apply', scratch);
    let parsed = 0;
    for (const name of Object.keys(changed.files).filter(n => /\.(ts|tsx|js|mjs)$/.test(n))) {
      let destination = name;
      for (const rename of [...changed.renames].sort((a,b)=>b.from.split('/').length-a.from.split('/').length)) {
        if(destination.startsWith(rename.from + '/')) destination = rename.to + destination.slice(rename.from.length);
      }
      const content = readFileSync(resolve(scratch, destination), 'utf8');
      assert(!/\.hyperfide-platform|hyperfide-platform\s*:/.test(content), name);
      const prior = [...baseline.get(name)];
      for (const diagnostic of diagnostics(destination, content)) {
        const index = prior.indexOf(diagnostic);
        assert(index >= 0, `${name}: introduced ${diagnostic}`);
        prior.splice(index, 1);
      }
      parsed++;
    }
    assert(parsed > 0);
    const second = await run('--dry-run', scratch);
    assert(second.rules.every(r => r.count === 0), 'scratch idempotence');
    console.log(`Parsed ${parsed} changed source files: zero introduced syntax errors`);
  } finally { rmSync(scratch, {recursive:true, force:true}); }
  console.log('rename fixtures, skipped files, directory moves, idempotence and platform coverage passed');
} finally {
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });
  writeFileSync(`${fixture}/.gitkeep`, '');
}
JS
