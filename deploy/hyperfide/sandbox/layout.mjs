import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const mappingPath = 'spec/hyperfide-source-control/repository-layout.json';
const commitPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const keys = ['schema_version', 'kind', 'layout_generation', 'mapping_digest', 'checkpoint_commit'];
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 << 20}).trim();
const refuse = message => { throw new Error('LAYOUT_IMAGE_INCOMPATIBLE: ' + message); };
export function layoutContract(root, revision) {
  if (revision !== undefined && !commitPattern.test(revision)) refuse('exact source revision required');
  let bytes;
  try { bytes = revision ? execFileSync('git', ['-C', root, 'show', `${revision}:${mappingPath}`], {maxBuffer: 4 << 20, stdio: ['ignore', 'pipe', 'pipe']}) : fs.readFileSync(path.join(root, mappingPath)); }
  catch { refuse('prepared source has no supported repository layout; build a new checkpoint'); }
  let mapping;
  try { mapping = JSON.parse(bytes); } catch { refuse('repository layout is malformed'); }
  if (mapping.schema_version !== 1 || typeof mapping.layout_generation !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(mapping.layout_generation)) refuse('explicit supported layout generation required');
  return {layout_generation: mapping.layout_generation, mapping_digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex')};
}
export function validateLayoutCompatibility(root, value) {
  const expected = layoutContract(root);
  if (!value || typeof value !== 'object' || value.layout_generation !== expected.layout_generation || value.mapping_digest !== expected.mapping_digest) refuse('prepared image layout generation or mapping differs');
  return expected;
}
export function revisionLayout(root, revision) {
  if (!commitPattern.test(revision ?? '')) refuse('exact checkpoint commit required');
  const expected = layoutContract(root), actual = layoutContract(root, revision);
  if (actual.layout_generation !== expected.layout_generation || actual.mapping_digest !== expected.mapping_digest) refuse('checkpoint commit uses a different repository layout');
  return {schema_version: 1, kind: 'HYPERFIDE_PREPARED_LAYOUT_V1', ...actual, checkpoint_commit: revision};
}
export function validateCheckpointLayout(root, commit, value) {
  validateLayoutCompatibility(root, value);
  const expected = revisionLayout(root, commit);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',') || keys.some(key => value[key] !== expected[key])) refuse('missing or stale checkpoint layout metadata; prepare and record a new checkpoint');
  return expected;
}
function marker(root) { return path.resolve(root, git(root, 'rev-parse', '--git-path', 'hyperfide-prepared-layout.json')); }
export function stampPreparedLayout(root, commit, expected) {
  const value = validateCheckpointLayout(root, commit, expected);
  if (git(root, 'rev-parse', 'HEAD') !== commit) refuse('only the actually prepared checkout can be stamped');
  const file = marker(root), temporary = file + '.' + randomUUID();
  fs.writeFileSync(temporary, JSON.stringify(value) + '\n', {flag: 'wx', mode: 0o600});
  fs.renameSync(temporary, file);
  return value;
}
export function probePreparedLayout(root, commit, expected) {
  const value = validateCheckpointLayout(root, commit, expected);
  let actual;
  try { const file = marker(root), stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || (stat.mode & 0o022)) refuse('private ordinary prepared marker required'); actual = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { refuse('prepared checkpoint marker is missing or invalid'); }
  validateCheckpointLayout(root, commit, actual);
  return value;
}
export function layoutCommand(action, layout) {
  if (!['stamp', 'probe'].includes(action)) refuse('unsupported layout operation');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  return 'node deploy/hyperfide/sandbox/layout.mjs ' + action + ' ' + [layout.checkpoint_commit, layout.layout_generation, layout.mapping_digest].map(quote).join(' ');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, commit, generation, digest, ...extra] = process.argv.slice(2);
  if (!['stamp', 'probe'].includes(action) || extra.length || !commitPattern.test(commit ?? '') || typeof generation !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(generation) || !/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) refuse('use stamp|probe COMMIT GENERATION MAPPING_DIGEST');
  const value = {schema_version: 1, kind: 'HYPERFIDE_PREPARED_LAYOUT_V1', checkpoint_commit: commit, layout_generation: generation, mapping_digest: digest};
  const result = action === 'stamp' ? stampPreparedLayout(process.cwd(), commit, value) : probePreparedLayout(process.cwd(), commit, value);
  console.log(JSON.stringify({status: 'PASS', action, ...result}));
}
