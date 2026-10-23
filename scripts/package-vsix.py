#!/usr/bin/env python3
"""Package editors/vscode as a VSIX at its package.json version, and check one.

  python3 -I scripts/package-vsix.py [--source DIR] [--out DIR]
      writes <out>/<name>-<version>.vsix (out defaults to the source directory)
      and removes any other <name>-*.vsix there, so a stale package cannot
      be installed by mistake.
  python3 -I scripts/package-vsix.py --check VSIX [--source DIR]
      exits 1 when the version the VSIX carries (its extension.vsixmanifest
      Identity and its extension/package.json) differs from the source
      package.json, or its identity is not the source's.

The extension has no dependencies, so the archive is the layout `vsce package`
writes (manifest, content types, extension/...) without needing npm.
"""
import argparse
import fnmatch
import json
import os
import re
import sys
import zipfile
from xml.sax.saxutils import escape, quoteattr

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SOURCE = os.path.join(HERE, '..', 'editors', 'vscode')
# vsce renames these three on the way in; everything else keeps its path
RENAMES = {'README.md': 'readme.md', 'CHANGELOG.md': 'changelog.md', 'LICENSE': 'LICENSE.txt'}
FIXED_DATE = (1980, 1, 1, 0, 0, 0)   # reproducible archives
CONTENT_TYPES = {
    '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json',
    '.md': 'text/markdown', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.txt': 'text/plain', '.vsixmanifest': 'text/xml',
}


def fail(msg):
    print('package-vsix: ' + msg, file=sys.stderr)
    sys.exit(1)


def read_package(source):
    with open(os.path.join(source, 'package.json'), encoding='utf-8') as f:
        return json.load(f)


def ignored(rel, patterns):
    if any(part.startswith('.') for part in rel.split('/')):
        return True
    for pat in patterns:
        if fnmatch.fnmatch(rel, pat) or (pat.startswith('**/') and fnmatch.fnmatch(rel, pat[3:])):
            return True
        if pat.endswith('/**') and (rel + '/').startswith(pat[:-2]):
            return True
    return False


def payload(source):
    patterns = []
    ign = os.path.join(source, '.vscodeignore')
    if os.path.exists(ign):
        with open(ign, encoding='utf-8') as f:
            patterns = [l.strip() for l in f if l.strip() and not l.startswith('#')]
    files = []
    for root, dirs, names in os.walk(source):
        dirs.sort()
        for name in sorted(names):
            full = os.path.join(root, name)
            rel = os.path.relpath(full, source).replace(os.sep, '/')
            if ignored(rel, patterns):
                continue
            files.append((full, 'extension/' + RENAMES.get(rel, rel)))
    return files


def manifest(pkg, entries):
    repo = (pkg.get('repository') or {}).get('url', '')
    repo_git = repo if repo.endswith('.git') or not repo else repo + '.git'
    tags = list(pkg.get('keywords', []))
    for lang in pkg.get('contributes', {}).get('languages', []):
        tags += [a.replace(' ', '') for a in lang.get('aliases', [])]
        tags += ['__ext_' + e.lstrip('.') for e in lang.get('extensions', [])]
    seen, uniq = set(), []
    for t in tags:
        if t not in seen:
            seen.add(t)
            uniq.append(t)
    assets = [('Microsoft.VisualStudio.Code.Manifest', 'extension/package.json')]
    for kind, path in (('Details', 'extension/readme.md'), ('Changelog', 'extension/changelog.md'),
                       ('License', 'extension/LICENSE.txt')):
        if path in entries:
            assets.append(('Microsoft.VisualStudio.Services.Content.' + kind, path))
    props = [
        ('Microsoft.VisualStudio.Code.Engine', pkg.get('engines', {}).get('vscode', '')),
        ('Microsoft.VisualStudio.Code.ExtensionDependencies', ''),
        ('Microsoft.VisualStudio.Code.ExtensionPack', ''),
        ('Microsoft.VisualStudio.Code.ExtensionKind', 'workspace'),
        ('Microsoft.VisualStudio.Code.ExecutesCode', 'true' if pkg.get('main') else 'false'),
    ]
    if repo:
        props += [
            ('Microsoft.VisualStudio.Services.Links.Source', repo_git),
            ('Microsoft.VisualStudio.Services.Links.GitHub', repo_git),
            ('Microsoft.VisualStudio.Services.Links.Support', repo_git[:-4] + '/issues'),
            ('Microsoft.VisualStudio.Services.Links.Learn', repo_git[:-4] + '#readme'),
        ]
    props += [('Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown', 'true'),
              ('Microsoft.VisualStudio.Services.Content.Pricing', 'Free')]
    lines = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"'
        ' xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">',
        '  <Metadata>',
        '    <Identity Language="en-US" Id=%s Version=%s Publisher=%s />' % (
            quoteattr(pkg['name']), quoteattr(pkg['version']), quoteattr(pkg['publisher'])),
        '    <DisplayName>%s</DisplayName>' % escape(pkg.get('displayName', pkg['name'])),
        '    <Description xml:space="preserve">%s</Description>' % escape(pkg.get('description', '')),
        '    <Tags>%s</Tags>' % escape(','.join(uniq)),
        '    <Categories>%s</Categories>' % escape(','.join(pkg.get('categories', []))),
        '    <GalleryFlags>Public</GalleryFlags>',
        '    <Properties>',
    ] + ['      <Property Id=%s Value=%s />' % (quoteattr(k), quoteattr(v)) for k, v in props] + [
        '    </Properties>',
    ] + (['    <License>extension/LICENSE.txt</License>'] if 'extension/LICENSE.txt' in entries else []) + [
        '  </Metadata>',
        '  <Installation>',
        '    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>',
        '  </Installation>',
        '  <Dependencies/>',
        '  <Assets>',
    ] + ['    <Asset Type=%s Path=%s Addressable="true" />' % (quoteattr(k), quoteattr(p)) for k, p in assets] + [
        '  </Assets>',
        '</PackageManifest>',
    ]
    return '\n'.join(lines) + '\n'


def content_types(entries):
    exts = sorted({os.path.splitext(e)[1].lower() for e in entries if os.path.splitext(e)[1]} | {'.vsixmanifest'})
    defaults = ''.join('<Default Extension=%s ContentType=%s/>' % (
        quoteattr(e), quoteattr(CONTENT_TYPES.get(e, 'application/octet-stream'))) for e in exts)
    return ('<?xml version="1.0" encoding="utf-8"?>\n'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">%s</Types>\n' % defaults)


def write(zf, name, data):
    info = zipfile.ZipInfo(name, FIXED_DATE)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    zf.writestr(info, data)


def package(source, out):
    pkg = read_package(source)
    for key in ('name', 'version', 'publisher'):
        if not pkg.get(key):
            fail('package.json has no ' + key)
    files = payload(source)
    entries = {arc for _, arc in files}
    os.makedirs(out, exist_ok=True)
    target = os.path.join(out, '%s-%s.vsix' % (pkg['name'], pkg['version']))
    tmp = target + '.tmp'
    with zipfile.ZipFile(tmp, 'w') as zf:
        write(zf, 'extension.vsixmanifest', manifest(pkg, entries))
        write(zf, '[Content_Types].xml', content_types(entries))
        for full, arc in files:
            with open(full, 'rb') as f:
                write(zf, arc, f.read())
    os.replace(tmp, target)
    for name in sorted(os.listdir(out)):
        stale = os.path.join(out, name)
        if name.startswith(pkg['name'] + '-') and name.endswith('.vsix') and stale != target:
            os.remove(stale)
            print('removed stale ' + stale)
    check(target, source)
    print(target)


def check(vsix, source):
    pkg = read_package(source)
    want = pkg['version']
    try:
        with zipfile.ZipFile(vsix) as zf:
            xml = zf.read('extension.vsixmanifest').decode('utf-8')
            inner = json.loads(zf.read('extension/package.json').decode('utf-8'))
    except (OSError, KeyError, zipfile.BadZipFile, ValueError) as e:
        fail('%s is not a readable VSIX: %s' % (vsix, e))
    ident = re.search(r'<Identity\b[^>]*>', xml)
    if not ident:
        fail('%s: extension.vsixmanifest has no Identity' % vsix)
    attrs = dict(re.findall(r'(\w+)="([^"]*)"', ident.group(0)))
    problems = []
    if attrs.get('Version') != want:
        problems.append('manifest version %s' % attrs.get('Version'))
    if inner.get('version') != want:
        problems.append('packaged package.json version %s' % inner.get('version'))
    if attrs.get('Id') != pkg['name'] or attrs.get('Publisher') != pkg['publisher']:
        problems.append('identity %s.%s' % (attrs.get('Publisher'), attrs.get('Id')))
    m = re.fullmatch(re.escape(pkg['name']) + r'-(.+)\.vsix', os.path.basename(vsix))
    if m and m.group(1) != want:
        problems.append('file name version %s' % m.group(1))
    if problems:
        fail('%s differs from %s/package.json (%s.%s %s): %s' % (
            vsix, os.path.normpath(source), pkg['publisher'], pkg['name'], want, '; '.join(problems)))
    print('%s matches package.json version %s' % (vsix, want))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--source', default=DEFAULT_SOURCE)
    ap.add_argument('--out')
    ap.add_argument('--check', metavar='VSIX')
    a = ap.parse_args()
    source = os.path.abspath(a.source)
    if a.check:
        check(a.check, source)
    else:
        package(source, os.path.abspath(a.out or source))


if __name__ == '__main__':
    main()
