#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, openSync, closeSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
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
  await execute('git', ['-C', fixture, 'add', '-f', '.']);
  const dry = await run('--dry-run', fixture);
  assert.equal(readFileSync(`${fixture}/sample.txt`, 'utf8'), original);
  for (const kind of ['identifier', 'text', 'path']) assert(dry.rules.some(r => r.kind === kind && r.count > 0));
  const applied = await run('--apply', fixture);
  assert.deepEqual(applied, dry);
  let expected = original;
  for (const rule of textRules) {
    const literal = rule.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = rule.kind === 'identifier' ? `\\b${literal}${/\w$/.test(rule.from) && !rule.from.endsWith('_') ? '\\b' : ''}` : literal;
    expected = expected.replace(new RegExp(pattern, 'g'), () => rule.to);
  }
  assert.equal(readFileSync(`${fixture}/sample.txt`, 'utf8'), expected);
  assert(expected.includes('@hyperfide/'));
  assert(expected.includes('HYPERFIDE_TELEMETRY'));
  assert(expected.includes('.hyperfide'));
  assert(expected.includes('hyperfide-platform'));
  assert(expected.includes('hyperfide.app'));
  assert(expected.includes('Hyperfide'));
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
  console.log('rename fixtures, skipped files, directory moves, idempotence and platform coverage passed');
} finally {
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });
  writeFileSync(`${fixture}/.gitkeep`, '');
}
JS
