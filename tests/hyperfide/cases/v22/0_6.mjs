import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { createRequire } from 'node:module';

assert.ok(['--prepare', '--check'].includes(process.argv[2]));
const root = resolve('platform');
const rules = JSON.parse(await readFile(join(root, 'tools/rename/map.json'), 'utf8'));
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function walk(dir) {
  const paths = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.env') || ['node_modules', 'dist', '.git', '.turbo', '__pycache__'].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) paths.push(...await walk(p));
    else if (e.isFile()) paths.push(p);
  }
  return paths;
}
const files = ['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'SECURITY.md'].map(p => join(root, p));
files.push(...await walk(join(root, 'docs')), ...await walk(join(root, 'assets')), ...await walk(join(root, 'apps/app/public')));
for (const e of await readdir(root, { withFileTypes: true })) {
  if (!e.isDirectory() || !e.name.startsWith('.')) continue;
  const p = join(root, e.name, 'skills');
  if (await stat(p).catch(() => false)) files.push(...await walk(p));
}
for (const e of await readdir(join(root, 'plugins'), { withFileTypes: true })) {
  if (!e.isDirectory() || ['connect', 'connect-next'].includes(e.name) || e.name.endsWith('-account')) continue;
  for (const n of ['README.md', 'PLUGIN_OVERVIEW.md']) {
    const p = join(root, 'plugins', e.name, n);
    if (await stat(p).catch(() => false)) files.push(p);
  }
}
if (process.argv[2] === '--prepare') {
  const temp = resolve(process.argv[3]);
  let count = 0;
  for (const p of files) {
    const bytes = await readFile(p);
    if (bytes.includes(0) || !Buffer.from(bytes.toString()).equals(bytes)) continue;
    let text = bytes.toString();
    // Broad text rules can match inside UUIDs, hashes, and base64. The manager
    // permits ignoring only hits whose preceding character is alphanumeric.
    for (const r of rules.filter(r => r.kind === 'text')) {
      text = text.replace(new RegExp(`([A-Za-z0-9])${escape(r.from)}`, 'g'), (_, prefix) => prefix + '_'.repeat(r.from.length));
    }
    const dest = join(temp, p.slice(root.length + 1));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, text);
    count++;
  }
  console.log(`Prepared ${count} text files for identity map --dry-run`);
} else {
  const report = JSON.parse(await readFile(process.argv[3], 'utf8'));
  const hits = report.rules.filter(r => r.kind !== 'path' && r.count);
  assert.deepEqual(hits, [], `Identity matches: ${JSON.stringify(hits)}`);
  console.log('Identity map --dry-run: zero matches');
const json = async p => JSON.parse(await readFile(join(root, p), 'utf8'));
const desktop = await json('apps/desktop/electron-builder.config.json');
assert.equal(desktop.productName, 'Hyperfide');
assert.equal(desktop.appId, 'dev.hyperfide.desktop');
assert.equal(desktop.linux.executableName, 'hyperfide');
assert.match((await json('apps/desktop/package.json')).description, /Hyperfide/);
assert.match(desktop.publish[0].url, /^https:\/\/github.com\/Sidiora-Labs\/hyperfide\//);
const mobile = (await json('apps/mobile/app.json')).expo;
assert.equal(mobile.name, 'Hyperfide');
assert.equal(mobile.slug, 'hyperfide');
assert.equal(mobile.scheme, 'hyperfide');
assert.equal(mobile.ios.bundleIdentifier, 'app.hyperfide.mobile');
assert.equal(mobile.android.package, 'app.hyperfide.mobile');
assert.equal(mobile.owner, undefined);
assert.equal(mobile.extra?.eas, undefined);
assert.equal(mobile.ios.associatedDomains, undefined);
assert.equal(mobile.android.intentFilters, undefined);
const require = createRequire(import.meta.url);
const configure = require(join(root, 'apps/mobile/app.config.js'));
// Discover the variant key without changing the runtime contract owned by 0.3.
const source = await readFile(join(root, 'apps/mobile/app.config.js'), 'utf8');
const variantKey = source.match(/process\.env\.([A-Z_]+MOBILE_VARIANT)/)[1];
const saved = process.env[variantKey];
try {
  for (const variant of ['production', 'dev']) {
    process.env[variantKey] = variant;
    const config = configure({ config: mobile });
    assert.equal(config.name, variant === 'dev' ? 'Hyperfide dev' : 'Hyperfide');
    assert.equal(config.android.package, variant === 'dev' ? 'app.hyperfide.mobile.dev' : 'app.hyperfide.mobile');
    for (const icon of [config.icon, config.web.favicon, config.android.adaptiveIcon.foregroundImage]) await stat(join(root, 'apps/mobile', icon));
  }
} finally {
  if (saved === undefined) delete process.env[variantKey]; else process.env[variantKey] = saved;
}
for (const p of (await walk(join(root, 'apps/app/public'))).filter(p => p.endsWith('.webmanifest'))) {
  const manifest = JSON.parse(await readFile(p, 'utf8'));
  assert.equal(manifest.name, 'Hyperfide');
  assert.equal(manifest.short_name, 'Hyperfide');
  for (const icon of manifest.icons) await stat(join(root, 'apps/app/public', icon.src));
}
const html = await readFile(join(root, 'apps/app/index.html'), 'utf8');
assert.match(html, /<title>Hyperfide<\/title>/);
assert.match(html, /name="apple-mobile-web-app-title" content="Hyperfide"/);
for (const p of ['apps/desktop/assets/icon.icns', 'apps/desktop/assets/icon-nightly.icns']) {
  const data = await readFile(join(root, p));
  assert.equal(data.toString('ascii', 0, 4), 'icns');
  assert.equal(data.readUInt32BE(4), data.length);
}
assert.match(await readFile(join(root, 'assets/README.md'), 'utf8'), /editors\/vscode\/media\/icon.png/);
console.log('Desktop, mobile production/dev, PWA manifests and native icon containers: passed');

}
