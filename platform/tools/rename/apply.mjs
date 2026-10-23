import { readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const [mode, target, ...extra] = process.argv.slice(2);
if (!['--dry-run', '--apply'].includes(mode) || !target || extra.length) throw Error('Usage: apply.mjs --dry-run|--apply ROOT');
const root = resolve(target);
const own = fileURLToPath(new URL('.', import.meta.url));
const rules = JSON.parse(await readFile(new URL('./map.json', import.meta.url)));
const files = [], directories = new Set();
const skipped = new Set(['node_modules', 'dist', '.turbo', '.git', 'licenses']);
async function walk(dir) {
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (skipped.has(e.name) || e.name.startsWith('.env') || p.startsWith(own)) continue;
    if (e.isDirectory()) { directories.add(relative(root,p)); await walk(p); }
    else if (e.isFile() && !['pnpm-lock.yaml','package-lock.json','yarn.lock'].includes(e.name)) files.push(p);
  }
}
await walk(root);
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const glob = (g,p) => new RegExp('^'+g.split('**').map(s=>s.split('*').map(escape).join('[^/]*')).join('.*')+'$').test(p);
const eligible = (r,p) => r.paths.some(g=>glob(g,p)) && !r.exclude.some(g=>glob(g,p));
const report = { rules: rules.map((r,index)=>({index,kind:r.kind,from:r.from,to:r.to,count:0,files:{}})), files:{}, renames:[] };
const pending=[];
for (const p of files) {
  const b=await readFile(p);
  if (b.includes(0) || !Buffer.from(b.toString()).equals(b)) continue;
  let text=b.toString();
  const name=relative(root,p);
  for (const [i,r] of rules.entries()) {
    if (r.kind==='path' || !eligible(r,name)) continue;
    const boundary = r.boundary ?? (r.kind === 'identifier' ? 'both' : 'none');
    const left = ['left', 'both'].includes(boundary) || /^[A-Za-z]/.test(r.from) ? '(?<![A-Za-z0-9])' : '';
    const right = ['right', 'both'].includes(boundary) ? '(?![A-Za-z0-9_])' : '';
    const regex=new RegExp(`${r.before ?? ''}${left}${escape(r.from)}${right}${r.after ?? ''}`,'g');
    let count=0;
    text=text.replace(regex,()=>{count++; return r.to;});
    if (count) { report.rules[i].count+=count; report.rules[i].files[name]=count; (report.files[name]??={})[i]=count; }
  }
  if(text!==b.toString()) pending.push([p,text]);
}
for(const [index,r] of rules.entries()) {
  if(r.kind!=='path' || !directories.has(r.from) || !eligible(r,r.from)) continue;
  try { await lstat(join(root,r.to)); throw Error(`Rename target exists: ${r.to}`); } catch(e) { if(e.code!=='ENOENT') throw e; }
  report.renames.push({index,from:r.from,to:r.to}); report.rules[index].count++;
}
if(mode==='--apply') {
  for(const [p,text] of pending) await writeFile(p,text);
  for(const r of [...report.renames].sort((a,b)=>b.from.split('/').length-a.from.split('/').length)) {
    await new Promise((resolve, reject) => {
      const child = spawn('git', ['mv', '--', r.from, r.to], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(Error(`git mv exited ${code}`)));
    });
  }
}
console.log(JSON.stringify(report,null,2));
