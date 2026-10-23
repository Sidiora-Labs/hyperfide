import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const root = resolve('platform');
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
const json = async p => JSON.parse(await readFile(join(root, p), 'utf8'));
// Read tracked manifests only: ignored build outputs may predate the rename.
const manifests = execFileSync('git', ['ls-files', '-z', '--', 'platform'], { encoding: 'utf8' })
  .split('\0').filter(p => p.endsWith('/package.json'));
let scopedPackages = 0;
let plugins = 0;
for (const path of manifests) {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  if (manifest.name?.startsWith('@')) {
    assert.match(manifest.name, /^@hyperfide\//, path);
    scopedPackages++;
  }
  if (path.startsWith('platform/plugins/') && manifest.hyperfide) {
    assert.match(manifest.name, /^(?:hyperfide-plugin-|@hyperfide\/hyperfide-)/, path);
    plugins++;
  }
}
assert.ok(scopedPackages > 0 && plugins > 0, 'Workspace and plugin manifests must be checked');
const cli = await json('apps/cli/package.json');
assert.equal(cli.bin['hyperfide-platform'], './bin/hyperfide-platform');
await stat(join(root, 'apps/cli', cli.bin['hyperfide-platform']));
assert.match(await readFile(join(root, 'packages/config/src/cli-command.ts'), 'utf8'),
  /CLI_LAUNCHER_ENV_NAME = "HYPERFIDE_CLI_LAUNCHER"/);
assert.match(await readFile(join(root, 'packages/config/src/runtime.ts'), 'utf8'),
  /HYPERFIDE_PROD_DATA_DIR_NAME = "\.hyperfide"/);
assert.match(await readFile(join(root, 'apps/server/src/services/plugins/builtin-registry.ts'), 'utf8'),
  /BUILTIN_PLUGIN_ID_PREFIX = "hyperfide--"/);
console.log(`Identity contracts: ${scopedPackages} scoped packages, ${plugins} plugins, CLI, environment and data directory passed`);
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
assert.equal(variantKey, 'HYPERFIDE_MOBILE_VARIANT');
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
