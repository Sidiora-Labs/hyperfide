#!/usr/bin/env python3
"""Check the actual task documents without qualifying the feature's other tasks.

The docs lifecycle only permits packet generation after ordinary qualification.
This isolated workspace gives the document check its own lifecycle; no source
spec statuses, shared graph, or documentation ledger are modified.
"""
from pathlib import Path
import json
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[4]
DOCUMENTS = [
    'README.md', 'docs/ARCHITECTURE.md', 'docs/hyperfide/platform.md',
    'docs/hyperfide/operations.md', 'platform/README.md',
    'deploy/hyperfide/sandbox/README.md',
]


def main():
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    documents = DOCUMENTS + [p for p in tracked if p.startswith('platform/docs/') and p.endswith('.md')]
    evidence = 'platform/plugins/memory/durable-memory.ts'
    with tempfile.TemporaryDirectory(prefix='hyperfide-docs-') as directory:
        work = Path(directory)

        def run(*args):
            subprocess.run([str(ROOT / 'cg'), *args], cwd=work, check=True)

        def copy(name):
            source, target = ROOT / name, work / name
            if source.is_file() and not source.name.startswith('.env'):
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)

        # Index the real packet adapter as a bounded public API claim. All other
        # tracked files are copied afterwards to resolve links against real files.
        copy(evidence)
        spec = work / 'spec/docs-review/spec.kvx'
        spec.parent.mkdir(parents=True)
        spec.write_text('[feature]\nname = "docs-review"\n[documentation]\n'
                        'mode = "manual"\nstatus = "pending"\n'
                        'targets = ["README.md", "docs/**", "platform/docs/**", '
                        '"platform/README.md", "deploy/hyperfide/sandbox/README.md"]\n'
                        '[task.baseline]\nwave = 0\nstatus = "done"\n'
                        'title = "Synthetic documentation lifecycle baseline"\n')
        (work / 'spec/workflow.kvx').write_text('[meta]\nactive_feature = "docs-review"\n')
        run('init')
        # Copy existing Markdown link targets, preserving their real contents.
        targets = {name for name in tracked if name.endswith(('.md', '.mdx', '.rst'))}
        for name in documents:
            for link in re.findall(r'\]\(([^)]+)\)', (ROOT / name).read_text()):
                link = link.split('#')[0]
                if link and not re.match(r'[a-zA-Z]+:', link):
                    target = (ROOT / name).parent / link
                    if target.is_file() and target.resolve().is_relative_to(ROOT):
                        targets.add(str(target.resolve().relative_to(ROOT)))
        for name in sorted(targets):
            if name not in documents:
                copy(name)
        copy('spec/hyperfide-v22/spec.kvx')
        # Linked source files are evidence targets, outside this documentation
        # task's API surface. Keep the packet adapter as the indexed claim.
        (work / '.cgignore').write_text('\n'.join(
            name for name in targets
            if name != evidence and not name.endswith(('.md', '.mdx', '.rst'))
        ) + '\n')
        run('commit', '-m', 'Documentation link-target baseline')
        for name in documents:
            copy(name)
        run('docs', 'packet', '-f', 'docs-review')
        ledger = work / '.codegraph/docs/docs-review/claims.kvx'
        ledger.write_text(
            '[coverage]\nuser = "README.md"\n'
            'developer = "docs/hyperfide/platform.md"\n'
            'release_or_migration = "docs/hyperfide/operations.md"\n'
            'exclusions = "Task 7.3 documents integrations; full API closure belongs to @docs."\n'
            'unresolved = ""\n\n'
            '[claim.1]\ntype = "symbol"\nvalue = "DurableMemoryBridge"\n'
            'document = "docs/hyperfide/platform.md"\n'
            f'evidence = {json.dumps(evidence + ":20")}\n\n'
            # Every exported type of the indexed surface is a required symbol; each needs a mapped claim.
            '[claim.2]\ntype = "symbol"\nvalue = "DurableMemory"\n'
            'document = "docs/hyperfide/platform.md"\n'
            f'evidence = {json.dumps(evidence + ":13")}\n\n'
            '[claim.3]\ntype = "symbol"\nvalue = "TaskScope"\n'
            'document = "docs/hyperfide/platform.md"\n'
            f'evidence = {json.dumps(evidence + ":18")}\n'
        )
        run('docs', 'check', '-f', 'docs-review')


if __name__ == '__main__':
    main()
