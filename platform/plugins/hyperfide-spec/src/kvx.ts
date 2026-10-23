import type { Feature, Status, Task } from './shared/model.js';

type Fields = Record<string, unknown>;
// KVX strings and arrays follow JSON escaping; comments apply outside strings.
export function parseKvx(source: string): Map<string, Fields> {
  const sections = new Map<string, Fields>();
  let fields: Fields = {};
  const clean = source.split('\n').map(line => {
    let quoted = false, escaped = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (escaped) { escaped = false; continue; }
      if (c === '\\' && quoted) { escaped = true; continue; }
      if (c === '"') quoted = !quoted;
      if (c === '#' && !quoted) return line.slice(0, i);
    }
    return line;
  }).join('\n');
  const lines = clean.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      if (sections.has(section[1])) throw new Error(`Duplicate KVX section ${section[1]}`);
      fields = {}; sections.set(section[1], fields); continue;
    }
    const entry = /^(\w+)\s*=\s*(.*)$/.exec(line);
    if (!entry) throw new Error(`Invalid KVX line ${i + 1}`);
    let value = entry[2];
    if (value.startsWith('[')) {
      while (!value.trimEnd().endsWith(']') && i + 1 < lines.length) value += '\n' + lines[++i];
    }
    try { fields[entry[1]] = JSON.parse(value); }
    catch { throw new Error(`Invalid KVX value for ${entry[1]}`); }
  }
  return sections;
}
const text = (value: unknown) => typeof value === 'string' ? value : '';
const list = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [];
export function featureFromKvx(id: string, source: string): Feature {
  const blocks = parseKvx(source);
  const meta = blocks.get('meta') ?? {};
  const tasks: Task[] = [];
  for (const [section, fields] of blocks) {
    if (!section.startsWith('task.')) continue;
    const reqs = list(fields.reqs);
    const criteria = reqs.flatMap(req => {
      const [requirement, clause] = req.split('.');
      const block = blocks.get(`req.${requirement}`) ?? {};
      return Object.entries(block).filter(([key]) => /^ac_\d+$/.test(key) && (!clause || key === `ac_${clause}`))
        .map(([key, value]) => ({ id: `${requirement}.${key.slice(3)}`, text: text(value) }));
    });
    const instructions = Object.entries(fields).filter(([key]) => /^do_\d+$/.test(key))
      .sort(([a], [b]) => Number(a.slice(3)) - Number(b.slice(3)));
    tasks.push({ id: section.slice(5), feature: id, title: text(fields.title),
      status: text(fields.status) as Status, wave: Number(fields.wave ?? 0),
      requires: list(fields.requires), touches: list(fields.touches), verify_cmd: text(fields.verify_cmd),
      do: instructions.map(([, value]) => text(value)), reqs, owner: text(fields.owner), criteria,
      ...Object.fromEntries(instructions),
    });
  }
  return { id, name: text(meta.name), status: text(meta.status), tasks };
}
