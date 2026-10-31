#!/usr/bin/env python3
"""Check the native source-control design pack; never execute product gates.

The strict KVX parser is shared with the original Hyperfide specification pack.
--render updates only the derived task plan and traceability view.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import runpy
import shlex
import subprocess
import sys
from urllib.parse import unquote, urlsplit


PACK = Path(__file__).resolve().parents[1]
REPO = PACK.parents[1]
PARSER = REPO / "spec/hyperfide/tools/validate_pack.py"
CONTRACTS = {
    1: "design.body.md", 2: "storage.md", 3: "storage.md",
    4: "protocol.md", 5: "protocol.md", 6: "workspaces.md",
    7: "protocol.md", 8: "hyperfide-integration.md", 9: "git-interop.md",
    10: "migration.md", 11: "identity-security.md", 12: "verification.md",
    13: "hyperfide-integration.md", 14: "README.md", 15: "repository-layout.md",
}
DERIVED = {"implementation-plan.md", "traceability.md"}


def numeric(value: str) -> tuple[int, ...]:
    return tuple(int(part) for part in value.split("."))


def task_order(tasks: dict) -> list[str]:
    ordered = []
    remaining = set(tasks)
    while remaining:
        ready = sorted((ident for ident in remaining
                        if set(tasks[ident]['requires']) <= set(ordered)), key=numeric)
        if not ready:
            raise ValueError('Task graph cannot be ordered')
        ordered.append(ready[0])
        remaining.remove(ready[0])
    return ordered


def task_plan(tasks: dict) -> str:
    lines = [
        "# Native source-control implementation plan", "",
        "Generated from [spec.kvx](spec.kvx); regenerate with "
        "`python3 spec/hyperfide-source-control/tools/validate_spec.py --render`.", "",
        "All implementation tasks are pending. This catalogue describes future work; "
        "the listed verification drivers are deliverables of those tasks, not existing passing gates.", "",
        "Dependencies determine eligibility. Wave numbers group integration and release obligations. "
        "Each package couples its implementation with a direct consumer and positive/negative checks. "
        "Component success does not qualify a complete product case or elapsed-time campaign.", "",
        "The repository-layout prerequisite runs first: **0.3 → 0.4 → 0.5 → 0.6 → 0.7 → 0.8 → 0.9**. "
        "Only then do native source-control tasks **0.1 → 0.2** become eligible. "
        "Existing task IDs are preserved; the list below follows dependencies.", "",
        "| Task | Wave | Scope | Requires | Owner |",
        "|---|---:|---|---|---|",
    ]
    for ident in task_order(tasks):
        task = tasks[ident]
        lines.append(f"| {ident} | {task['wave']} | {task['title']} | "
                     f"{', '.join(task['requires']) or 'None'} | {task['owner']} |")
    for ident in task_order(tasks):
        task = tasks[ident]
        lines += ["", f"## {ident}: {task['title']}", "",
                  f"Status: **{task['status']}**. Owner: `{task['owner']}`. "
                  f"Dependencies: {', '.join(task['requires']) or 'none'}.", "",
                  "Proposed implementation scope:", ""]
        lines += [f"- `{path}`" for path in task['touches']]
        lines += ["", f"Future focused gate: `{task['verify_cmd']}`.", "",
                  "Acceptance clauses: " + ", ".join(task['reqs']) + ".",
                  "Canonical cases: " + ", ".join(task['cases']) + " (UNRUN).", "",
                  "Implementation and qualification obligations:", ""]
        steps = sorted((key for key in task if re.fullmatch(r"do_\d+", key)),
                       key=lambda key: int(key.split("_")[1]))
        lines += [f"{index}. {task[key]}" for index, key in enumerate(steps, 1)]
    return "\n".join(lines) + "\n"


def traceability(requirements: dict, tasks: dict, cases: dict) -> str:
    lines = [
        "# Native source-control traceability", "",
        "Generated from [spec.kvx](spec.kvx). A clause `N.M` is `[req.N] ac_M`. "
        "Mappings describe planned coverage, not execution evidence. All product cases are UNRUN.", "",
        "| Clause | Requirement | Implementation tasks | Product cases | Contract |",
        "|---|---|---|---|---|",
    ]
    for number in sorted(requirements, key=int):
        req = requirements[number]
        for field in sorted((key for key in req if re.fullmatch(r"ac_\d+", key)),
                            key=lambda key: int(key.split("_")[1])):
            clause = number + "." + field.split("_")[1]
            owners = [key for key in sorted(tasks, key=numeric) if clause in tasks[key]['reqs']]
            checks = [key for key in sorted(cases) if clause in cases[key]['reqs']]
            contract = CONTRACTS[int(number)]
            lines.append(f"| {clause} | {req['title']} | {', '.join(owners)} | "
                         f"{', '.join(checks)} | [{contract}]({contract}) |")
    lines += ["", "## Canonical case ownership", "",
              "A case's tasks are the implementation packages responsible for its driver, "
              "behavior or final integration. Full-case completion requires every registered "
              "assertion and mandatory backend/campaign variant described in [verification.md](verification.md).", "",
              "| Case | Scope | Tasks | Independent oracle |", "|---|---|---|---|"]
    for ident, case in sorted(cases.items()):
        lines.append(f"| {ident} | {case['title']} ({case['tier']}) | "
                     f"{', '.join(case['tasks'])} | {case['oracle']} |")
    return "\n".join(lines) + "\n"


def string_list(value) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) and item for item in value)


def validate(sections: dict) -> tuple[list[str], dict, dict, dict]:
    errors = []
    requirements = {key[4:]: value for key, value in sections.items() if key.startswith('req.')}
    tasks = {key[5:]: value for key, value in sections.items() if key.startswith('task.')}
    cases = {key[5:]: value for key, value in sections.items() if key.startswith('case.')}
    meta = sections.get('meta', {})
    if meta.get('feature') != 'hyperfide-source-control' or meta.get('status') != 'pending' or meta.get('stage') != 'design':
        errors.append('This draft requires feature=hyperfide-source-control, status=pending, stage=design')
    if set(requirements) != {str(n) for n in range(1, 16)}:
        errors.append('Expected exactly requirement sections 1 through 15')
    if set(cases) != {f'SCM-{n:03d}' for n in range(1, 26)}:
        errors.append('Expected exactly canonical cases SCM-001 through SCM-025')
    clauses = set()
    for ident, req in requirements.items():
        for field in ('title', 'story'):
            if not isinstance(req.get(field), str) or not req[field]:
                errors.append(f'req {ident}: missing {field}')
        acs = sorted(int(key[3:]) for key in req if re.fullmatch(r'ac_\d+', key))
        if not acs or acs != list(range(1, len(acs) + 1)):
            errors.append(f'req {ident}: acceptance clauses must be consecutive from 1')
        for n in acs:
            clauses.add(f'{ident}.{n}')
            if not isinstance(req[f'ac_{n}'], str) or 'SHALL' not in req[f'ac_{n}']:
                errors.append(f'req {ident}.{n}: missing normative acceptance statement')
    task_coverage = set()
    for ident, task in tasks.items():
        if not re.fullmatch(r'\d+\.\d+', ident):
            errors.append(f'invalid task ID {ident}')
            continue
        if task.get('status') != 'pending':
            errors.append(f'task {ident}: draft implementation must be pending')
        if type(task.get('wave')) is not int or task['wave'] != int(ident.split('.')[0]):
            errors.append(f'task {ident}: wave must match ID prefix')
        for field in ('title', 'owner'):
            if not isinstance(task.get(field), str) or not task[field]:
                errors.append(f'task {ident}: missing {field}')
        for field in ('requires', 'touches', 'reqs', 'cases'):
            values = task.get(field)
            if not string_list(values) or (field != 'requires' and not values):
                errors.append(f'task {ident}: invalid {field}')
            elif len(values) != len(set(values)):
                errors.append(f'task {ident}: duplicate {field}')
        if not all(isinstance(value, str) for key, value in task.items() if key.startswith('do_')):
            errors.append(f'task {ident}: invalid implementation step')
        steps = sorted(int(key[3:]) for key in task if re.fullmatch(r'do_\d+', key))
        if len(steps) < 4 or steps != list(range(1, len(steps) + 1)):
            errors.append(f'task {ident}: need at least four consecutive implementation/test steps')
        expected = ['python3', 'tests/hyperfide/cases/source_control/' + ident.replace('.', '_') + '.py']
        try:
            actual = shlex.split(task.get('verify_cmd', ''))
        except (TypeError, ValueError):
            actual = []
        if actual != expected:
            errors.append(f'task {ident}: future verification command must be {shlex.join(expected)}')
        for path in task.get('touches', []):
            if Path(path).is_absolute() or '..' in Path(path).parts:
                errors.append(f'task {ident}: scope escapes repository: {path}')
        for dep in task.get('requires', []):
            if dep not in tasks:
                errors.append(f'task {ident}: unknown dependency {dep}')
            elif tasks[dep].get('wave', -1) > task.get('wave', -1):
                errors.append(f'task {ident}: dependency {dep} is in a later wave')
        for ref in task.get('reqs', []):
            if ref not in clauses:
                errors.append(f'task {ident}: unknown acceptance clause {ref}')
            task_coverage.add(ref)
        expected_cases = {case_id for case_id, case in cases.items() if ident in case.get('tasks', [])}
        if set(task.get('cases', [])) != expected_cases:
            errors.append(f'task {ident}: asymmetric task/case mapping')
    remaining = set(tasks)
    while remaining:
        ready = {ident for ident in remaining if not (set(tasks[ident].get('requires', [])) & remaining)}
        if not ready:
            errors.append('dependency cycle: ' + ', '.join(sorted(remaining)))
            break
        remaining -= ready
    case_coverage = set()
    for ident, case in cases.items():
        if case.get('status') != 'UNRUN':
            errors.append(f'case {ident}: product qualification must remain UNRUN')
        for field in ('title', 'tier', 'oracle'):
            if not isinstance(case.get(field), str) or not case[field]:
                errors.append(f'case {ident}: missing {field}')
        for field in ('reqs', 'tasks'):
            values = case.get(field)
            if not string_list(values) or not values or len(values) != len(set(values)):
                errors.append(f'case {ident}: invalid or duplicate {field}')
        for ref in case.get('reqs', []):
            if ref not in clauses:
                errors.append(f'case {ident}: unknown acceptance clause {ref}')
            case_coverage.add(ref)
        for task in case.get('tasks', []):
            if task not in tasks:
                errors.append(f'case {ident}: unknown task {task}')
    for label, coverage in [('task', task_coverage), ('case', case_coverage)]:
        for clause in sorted(clauses - coverage, key=numeric):
            errors.append(f'acceptance clause {clause} has no {label} coverage')
    return errors, requirements, tasks, cases


def layout_errors(sections: dict, tasks: dict) -> tuple[list[str], dict]:
    errors = []
    layout = json.loads((PACK / 'repository-layout.json').read_text())
    if layout.get('source_baseline') != sections['meta'].get('source_baseline'):
        errors.append('Layout and source specification baselines differ')
    if layout.get('status') != 'proposed' or layout.get('qualification') != 'UNRUN':
        errors.append('Layout draft must remain proposed and UNRUN')
    rules = layout.get('mappings', [])
    sources = [rule['source'] for rule in rules]
    if len(sources) != len(set(sources)):
        errors.append('Duplicate layout source rules')
    for rule in rules + layout.get('planned_paths', []):
        for key in ('source', 'destination'):
            path = rule.get(key, '')
            if not path or Path(path).is_absolute() or '..' in Path(path).parts:
                errors.append(f'Invalid layout {key}: {path!r}')
    result = subprocess.run(
        ['git', 'ls-tree', '-r', '--name-only', '-z', layout['source_baseline']],
        cwd=REPO, capture_output=True, check=False,
    )
    if result.returncode:
        return errors + ['Cannot read pinned layout source inventory from Git'], {}
    paths = [value for value in result.stdout.decode('utf-8').split('\0') if value]
    ranked = sorted(rules, key=lambda rule: len(rule['source']), reverse=True)

    def match(path):
        return next((rule for rule in ranked if path == rule['source']
                     or path.startswith(rule['source'] + '/')), None)

    destinations = {}
    covered = 0
    for path in paths:
        rule = match(path)
        if path.startswith(('platform/', 'services/')):
            if rule is None:
                errors.append(f'Unmapped nested source input: {path}')
            else:
                covered += 1
        destination = rule['destination'] + path[len(rule['source']):] if rule else path
        destinations.setdefault(destination, []).append((path, rule))
    intentional_merges = 0
    for destination, inputs in destinations.items():
        if len(inputs) < 2:
            continue
        if any(rule and rule.get('action', '').startswith('merge') for _, rule in inputs):
            intentional_merges += 1
        else:
            errors.append(f'Unresolved layout destination collision at {destination}: '
                          + ', '.join(path for path, _ in inputs))
    units = {str(Path(path).parent) for path in paths
             if path.endswith('/package.json') and len(Path(path).parts) == 4
             and path.startswith(('platform/apps/', 'platform/packages/'))}
    mapped_units = {rule['source'] for rule in rules if rule.get('package_name')}
    if units != mapped_units:
        errors.append('Layout must explicitly classify every direct application/package unit')
    prerequisite = sections.get('prerequisite.repository_layout', {})
    layout_tasks = {f'0.{n}' for n in range(3, 10)}
    if set(prerequisite.get('tasks', [])) != layout_tasks or prerequisite.get('gate_task') != '0.9':
        errors.append('Layout prerequisite task set or gate is invalid')
    if tasks.get('0.1', {}).get('requires') != ['0.9']:
        errors.append('Native task 0.1 must require the qualified layout gate 0.9')

    def ancestors(ident, seen=None):
        seen = set() if seen is None else seen
        for dependency in tasks.get(ident, {}).get('requires', []):
            if dependency not in seen:
                seen.add(dependency)
                ancestors(dependency, seen)
        return seen

    for ident, task in tasks.items():
        if ident in layout_tasks:
            if ancestors(ident) - layout_tasks:
                errors.append(f'Layout task {ident} depends on native implementation')
            continue
        if '0.9' not in ancestors(ident):
            errors.append(f'Native task {ident} bypasses layout qualification')
        for path in task.get('touches', []):
            if path.startswith(('platform/', 'services/', 'src/', 'editors/', 'kvx/')):
                errors.append(f'Native task {ident} retains pre-layout destination {path}')
    return errors, {'mapping_rules': len(rules), 'classified_app_package_units': len(units),
                    'covered_platform_service_files': covered, 'explicit_merges': intentional_merges,
                    'prerequisite_gate': '0.9', 'runtime_qualification': 'UNRUN'}


def document_errors(rendering: bool) -> list[str]:
    errors = []
    for path in sorted(PACK.rglob('*')):
        if not path.is_file() or '__pycache__' in path.parts or path.suffix not in {'.md', '.kvx', '.mmd', '.py'}:
            continue
        text = path.read_text()
        for number, line in enumerate(text.splitlines(), 1):
            if line.rstrip() != line:
                errors.append(f'{path.relative_to(PACK)}:{number}: trailing whitespace')
        if path.suffix != '.md':
            continue
        for target in re.findall(r'\[[^\]\n]*\]\(([^)]+)\)', text):
            parsed = urlsplit(target.strip('<>'))
            if parsed.scheme or not parsed.path:
                continue
            resolved = (path.parent / unquote(parsed.path)).resolve()
            if rendering and resolved.parent == PACK and resolved.name in DERIVED:
                continue
            if not resolved.exists():
                errors.append(f'{path.relative_to(PACK)}: missing linked target {target}')
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--render', action='store_true', help='Update derived task/traceability documents')
    args = parser.parse_args()
    try:
        parse_kvx = runpy.run_path(str(PARSER))['parse_kvx']
        sections = parse_kvx((PACK / 'spec.kvx').read_text())
        errors, requirements, tasks, cases = validate(sections)
        layout_problems, layout_summary = layout_errors(sections, tasks)
        errors += layout_problems
        errors += document_errors(args.render)
        if errors:
            print(json.dumps({'status': 'FAIL', 'scope': 'specification-authoring', 'errors': errors}, indent=2))
            return 1
        views = {'implementation-plan.md': task_plan(tasks),
                 'traceability.md': traceability(requirements, tasks, cases)}
        for name, content in views.items():
            path = PACK / name
            if args.render:
                path.write_text(content)
            elif not path.is_file() or path.read_text() != content:
                errors.append(f'{name}: derived view is missing/stale; run --render')
        result = {
            'status': 'FAIL' if errors else 'PASS', 'scope': 'specification-authoring',
            'checked_at': datetime.now(timezone.utc).isoformat(),
            'feature': sections['meta']['feature'],
            'spec_sha256': hashlib.sha256((PACK / 'spec.kvx').read_bytes()).hexdigest(),
            'requirements': len(requirements),
            'acceptance_clauses': sum(len([key for key in req if re.fullmatch(r'ac_\d+', key)]) for req in requirements.values()),
            'tasks': len(tasks), 'waves': sorted({task['wave'] for task in tasks.values()}),
            'cases': len(cases), 'implementation': 'pending', 'product_qualification': 'UNRUN',
            'rendered': args.render, 'errors': errors,
            'layout': layout_summary,
            'inputs_sha256': {
                str(path.relative_to(PACK)): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in sorted(PACK.rglob('*'))
                if path.is_file() and path.suffix in {'.md', '.kvx', '.mmd', '.py', '.json'}
                and '__pycache__' not in path.parts
                and path.name != 'authoring-validation.json'
            },
        }
        print(json.dumps(result, indent=2))
        return int(bool(errors))
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(json.dumps({'status': 'FAIL', 'scope': 'specification-authoring', 'errors': [str(exc)]}, indent=2))
        return 1


if __name__ == '__main__':
    sys.exit(main())
