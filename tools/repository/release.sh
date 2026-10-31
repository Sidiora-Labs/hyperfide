#!/usr/bin/env bash
# Construct a nonpublishing, checksummed Hyperfide release on a remote executor.
# Usage: tools/repository/release.sh --output DIR [--dry-run] [--skip-tests]
# Publication destinations are operator configuration; this script never publishes.
set -euo pipefail
cd "$(dirname "$0")/../.."
output=""
run_tests=1
dry_run=0
while [ "$#" -gt 0 ]; do
 case "$1" in
  --output) [ "$#" -ge 2 ] || exit 2; output="$2"; shift 2 ;;
  --dry-run) dry_run=1; shift ;;
  --skip-tests) run_tests=0; shift ;;
  *) echo "usage: tools/repository/release.sh --output DIR [--dry-run] [--skip-tests]" >&2; exit 2 ;;
 esac
done
[ -n "$output" ] || { echo "hyperfide release: --output is required" >&2; exit 2; }
# Build the same additional artifacts in dry-run and signed release modes.
release_v22_artifacts() {
 pnpm exec turbo run build --filter=@hyperfide/server --filter=@hyperfide/host-daemon --filter=@hyperfide/app --filter=@hyperfide/cli
 npm --prefix core/control-plane run check
 npm --prefix core/control-plane run build
 python3 - "$output" <<'PY'
from pathlib import Path
import hashlib,json,os,re,shutil,subprocess,sys,tarfile,tempfile,zipfile
root=Path.cwd(); output=Path(sys.argv[1]).resolve();output.mkdir(parents=True,exist_ok=True)
version='2.2.0'
def archive(stage,name):
 target=output/f'hyperfide-{name}-{version}.tar.gz'
 with tarfile.open(target,'w:gz',compresslevel=6) as tar:
  for child in sorted(stage.iterdir()):tar.add(child,arcname=child.name)
 return target
with tempfile.TemporaryDirectory(prefix='hyperfide-release-') as tmp:
 temp=Path(tmp)
 for component in ['server','host-daemon','app']:
  source=root/{'server':'core/server','host-daemon':'core/host-daemon','app':'apps/web'}[component];stage=temp/component;stage.mkdir()
  shutil.copytree(source/'dist',stage/'dist')
  shutil.copyfile(source/'package.json',stage/'package.json')
  if component!='app':
   # Retain the installed dependency graph, including native binaries, using
   # internal relative links only. Nothing in an archive points at the checkout.
   resolver=r'''
const {createRequire}=require('node:module');const fs=require('node:fs');const path=require('node:path');
const roots=['@parcel/watcher','better-sqlite3','bufferutil','node-pty','pino','pino-pretty','pino-roll','thread-stream','utf-8-validate'];
const graph={};
function resolve(name,base){const r=createRequire(path.join(base,'package.json'));try{return fs.realpathSync(r.resolve(name+'/package.json'))}catch{try{let p=path.dirname(r.resolve(name));while(!fs.existsSync(path.join(p,'package.json')))p=path.dirname(p);return fs.realpathSync(path.join(p,'package.json'))}catch{return null}}}
function visit(file){if(graph[file])return;const pkg=JSON.parse(fs.readFileSync(file));const deps={};graph[file]=deps;for(const name of Object.keys({...pkg.dependencies,...pkg.optionalDependencies})){const child=resolve(name,path.dirname(file));if(child){deps[name]=child;visit(child)}else if(!pkg.optionalDependencies?.[name])throw Error('Missing dependency '+name)}}
const entries={};for(const name of roots){const file=resolve(name,process.argv[1]);if(file){entries[name]=file;visit(file)}}console.log(JSON.stringify({entries,graph}));
'''
   graph=json.loads(subprocess.check_output(['node','-e',resolver,str(source)],text=True))
   store=stage/'node_modules/.hyperfide';store.mkdir(parents=True)
   locations={file:store/str(i) for i,file in enumerate(graph['graph'])}
   for file,location in locations.items():
    shutil.copytree(Path(file).parent,location,ignore=shutil.ignore_patterns('node_modules','.git','.env','.env.*'),symlinks=False)
   def link(base,name,file):
    target=base/name;target.parent.mkdir(parents=True,exist_ok=True);target.symlink_to(os.path.relpath(locations[file],target.parent),target_is_directory=True)
   for file,deps in graph['graph'].items():
    for name,child in deps.items():link(locations[file]/'node_modules',name,child)
   for name,file in graph['entries'].items():link(stage/'node_modules',name,file)
  if component=='host-daemon':
   # Preserve the sibling CLI layout used by the daemon's runtime resolver.
   (stage/'host-daemon').mkdir();shutil.move(stage/'dist',stage/'host-daemon/dist')
   cli=root/'apps/cli'
   for name in ['dist','bin']:shutil.copytree(cli/name,stage/'cli'/name)
   shutil.copyfile(cli/'package.json',stage/'cli/package.json')
  archive(stage,'platform-'+component)
 service=temp/'service';service.mkdir();shutil.copytree(root/'core/control-plane/dist',service/'dist')
 for name in ['components','migrations']:
  source=root/'core/control-plane'/name
  if source.is_dir():shutil.copytree(source,service/name,ignore=shutil.ignore_patterns('.env','.env.*'))
 for name in ['package.json','package-lock.json']:shutil.copyfile(root/'core/control-plane'/name,service/name)
 subprocess.run(['npm','ci','--omit=dev','--ignore-scripts'],cwd=service,check=True)
 archive(service,'service')
 binary=temp/'binary';(binary/'bin').mkdir(parents=True);shutil.copyfile(root/'hyperfide',binary/'bin/hyperfide');(binary/'bin/hyperfide').chmod(0o755);archive(binary,'binary')
 with zipfile.ZipFile(output/f'hyperfide-{version}.vsix','w',zipfile.ZIP_DEFLATED) as vsix:
  for name in subprocess.check_output(['git','ls-files','--','extensions/vscode'],text=True).splitlines():
   file=root/name
   if file.is_file() and not file.name.startswith('.env') and 'test' not in file.parts:vsix.write(file,'extension/'+file.relative_to(root/'extensions/vscode').as_posix())
  vsix.writestr('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>')
  vsix.writestr('extension.vsixmanifest',f'''<?xml version="1.0"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="hyperfide-language-client" Version="{version}" Publisher="SidioraLabs"/><DisplayName>Hyperfide</DisplayName><Description xml:space="preserve">Hyperfide language navigation</Description></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" Version="[1.75.0,)"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets></PackageManifest>''')
# Read only done tasks, retaining wave order rather than declaration order.
sections=[];current=None
for line in (root/'spec/hyperfide-v22/spec.kvx').read_text().splitlines():
 match=re.fullmatch(r'\[task\.([^]]+)\]',line)
 if line.startswith('['):current=None
 if match:current={'id':match[1]};sections.append(current)
 elif current is not None and '=' in line:
  key,value=line.split('=',1)
  try:current[key.strip()]=json.loads(value.strip())
  except ValueError:pass
notes=['# Hyperfide 2.2.0',''];wave=None
for task in sorted((t for t in sections if t.get('status')=='done'),key=lambda t:(t['wave'],[int(x) for x in t['id'].split('.')])):
 if task['wave']!=wave:wave=task['wave'];notes+=['',f'## Wave {wave}','']
 notes.append(f"- {task['id']}: {task['title']}")
(output/'release-notes.md').write_text('\n'.join(notes)+'\n')
PY
 cat > "$output/smoke.py" <<'PY'
#!/usr/bin/env python3
"""Boot the extracted Hyperfide server and daemon with isolated local state."""
from pathlib import Path
import json,os,socket,subprocess,sys,tarfile,tempfile,time,urllib.request
release=Path(__file__).resolve().parent

def port():
 with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
def request(url,body=None):
 req=urllib.request.Request(url,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=2) as response:return response.read()
def wait(url,process):
 for _ in range(180):
  if process.poll() is not None:raise RuntimeError('archive process exited: '+str(process.returncode))
  try:return request(url)
  except (OSError,TimeoutError):time.sleep(.5)
 raise RuntimeError('archive health timed out: '+url)
with tempfile.TemporaryDirectory(prefix='hyperfide-release-smoke-') as tmp:
 work=Path(tmp);processes=[];logs=[]
 try:
  for name in ['server','host-daemon','app','binary','service']:
   artifact=('platform-'+name) if name in ['server','host-daemon','app'] else name
   dest=work/name;dest.mkdir()
   with tarfile.open(release/f'hyperfide-{artifact}-2.2.0.tar.gz') as tar:tar.extractall(dest,filter='data')
  assert subprocess.check_output([str(work/'binary/bin/hyperfide'),'--version'],text=True).strip()=='2.2.0'
  assert (work/'app/dist/index.html').is_file()
  server_port=port();daemon_port=port();url=f'http://127.0.0.1:{server_port}'
  env={k:v for k,v in os.environ.items() if not k.startswith('HYPERFIDE_') and k not in ['NODE_PATH','NODE_OPTIONS']}
  env.update(NODE_ENV='production',HOME=str(work),HYPERFIDE_SERVER_BIND_HOST='127.0.0.1',HYPERFIDE_SERVER_PORT=str(server_port),HYPERFIDE_HOST_DAEMON_PORT=str(daemon_port),HYPERFIDE_APP_VERSION='2.2.0',HYPERFIDE_SKIP_ONBOARDING='true')
  def launch(name,extra):
   log=open(work/(name+'.log'),'w+');logs.append(log)
   entry=work/name/('host-daemon/dist/index.js' if name=='host-daemon' else 'dist/index.js')
   process=subprocess.Popen(['node',str(entry)],cwd=work,env=dict(env,**extra),stdout=log,stderr=log,start_new_session=True);processes.append(process);return process
  server=launch('server',{'HYPERFIDE_DATA_DIR':str(work/'server-data')})
  wait(url+'/health',server)
  key=json.loads(request(url+'/internal/hosts/enroll-key',{}))
  daemon=launch('host-daemon',{'HYPERFIDE_DATA_DIR':str(work/'daemon-data'),'HYPERFIDE_SERVER_URL':url,'HYPERFIDE_HOST_ENROLL_KEY':key['enrollKey'],'HYPERFIDE_HOST_ID':key['hostId'],'HYPERFIDE_HOST_DAEMON_AUTO_UPDATE':'false'})
  wait(f'http://127.0.0.1:{daemon_port}/health',daemon)
  assert server.poll() is None and daemon.poll() is None
  print('Hyperfide archive smoke passed')
 except BaseException:
  for log in logs:log.flush();log.seek(0);sys.stderr.write(log.read())
  raise
 finally:
  import signal
  for process in reversed(processes):
   if process.poll() is None:os.killpg(process.pid,signal.SIGTERM)
  for process in reversed(processes):
   try:process.wait(timeout=10)
   except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL);process.wait()
  for log in logs:log.close()
PY
 chmod +x "$output/smoke.py"
 python3 - "$output" <<'PY'
import hashlib,sys
from pathlib import Path
out=Path(sys.argv[1]);files=sorted(p for p in out.iterdir() if p.is_file() and p.name not in {'SHA256SUMS','SHA256SUMS.sig'})
(out/'SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n' for p in files))
PY
}

if [ "$dry_run" -eq 1 ]; then
 make -j "${HYPERFIDE_BUILD_JOBS:-2}" all
 release_v22_artifacts
 exit 0
fi
# Unsigned releases are refused before any build: manifest.sig and release.json.sig both come from this key.
case "${HYPERFIDE_RELEASE_SIGNING_KEY_FILE:-}" in /*) ;; *) echo "hyperfide release: HYPERFIDE_RELEASE_SIGNING_KEY_FILE (absolute Ed25519 private key) is required" >&2; exit 2 ;; esac
# The key gate stats the key file itself (exists, regular, owner-only, Ed25519) before git, make or npm run.
tools/repository/release-sign.sh --check-key "$HYPERFIDE_RELEASE_SIGNING_KEY_FILE" >/dev/null
[ -z "$(git status --porcelain --untracked-files=normal)" ] || { echo "hyperfide release: source checkout must be committed and clean" >&2; exit 2; }
case "${HYPERFIDE_BUILD_PLACEMENT:-}" in
 remote) ;;
 *) echo "hyperfide release: HYPERFIDE_BUILD_PLACEMENT=remote is required by the supervision-only placement contract" >&2; exit 2 ;;
esac
make -j "${HYPERFIDE_BUILD_JOBS:-2}" all hyperfide-native
[ -x ./hyperfide ] || { echo "hyperfide release: canonical native artifact is missing" >&2; exit 1; }
[ "$(./hyperfide --version)" = "2.2.0" ] || { echo "hyperfide release: unsupported development release identity" >&2; exit 1; }
if [ "$run_tests" -eq 1 ]; then make -j1 test; fi
python3 - "$output" "$run_tests" <<'PY'
from pathlib import Path
import gzip,hashlib,json,os,re,shutil,stat,subprocess,sys,tarfile,tempfile
root=Path.cwd();output=Path(sys.argv[1]).resolve();output.mkdir(parents=True,exist_ok=True)
def run(*args,**kw):return subprocess.check_output(args,text=True,**kw).strip()
def digest(p):return 'sha256:'+hashlib.sha256(p.read_bytes()).hexdigest()
def digest_bytes(value):return 'sha256:'+hashlib.sha256(value).hexdigest()
def copy_file(source,target,mode=None):
 target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target);target.chmod(mode if mode else (0o755 if source.stat().st_mode&0o111 else 0o644))
node=Path(shutil.which('node')).resolve()
if run(str(node),'--version')!='v24.22.0' or run('npm','--version')!='11.19.1':raise SystemExit('hyperfide release: pinned Node/npm toolchain is required')
if sys.platform!='linux' or os.uname().machine!='x86_64':raise SystemExit('hyperfide release: supported release profile is Linux x64')
if sys.version_info[:3]!=(3,14,8):raise SystemExit('hyperfide release: Python3.14.8 is required for the qualified subreaper runtime')
python_prefix=Path(sys.base_prefix).resolve()
commit=run('git','rev-parse','HEAD');epoch=run('git','show','-s','--format=%ct','HEAD')
with tempfile.TemporaryDirectory(prefix='hyperfide-release-build-') as temporary:
 # The build tree mirrors the checkout layout: npm run build stamps dist through ../../deploy/hyperfide/dist-stamp.mjs.
 temp=Path(temporary);build=temp/'core/control-plane';build.mkdir(parents=True)
 stamp_tool=temp/'deploy/hyperfide/dist-stamp.mjs';copy_file(root/'deploy/hyperfide/dist-stamp.mjs',stamp_tool)
 for name in ['package.json','package-lock.json','tsconfig.json']:copy_file(root/'core/control-plane'/name,build/name)
 shutil.copytree(root/'core/control-plane/src',build/'src')
 subprocess.run(['npm','ci','--ignore-scripts'],cwd=build,check=True)
 subprocess.run(['npm','run','check'],cwd=build,check=True)
 subprocess.run(['npm','run','build'],cwd=build,check=True)
 # The shipped dist must be the build of the committed source; dist/.source-digest.json then rides in the signed manifest.
 if subprocess.run([str(node),str(stamp_tool),'check',str(build)]).returncode:raise SystemExit('hyperfide release: services dist is stale against its source')
 stage=temp/'release';stage.mkdir()
 copy_file(root/'hyperfide',stage/'bin/hyperfide',0o755)
 copy_file(root/'hyperfide',stage/'bin/cg',0o755)
 copy_file(root/'build/hyperfide-native',stage/'bin/hyperfide-native',0o755)
 copy_file(node,stage/'runtime/node',0o755)
 python_stage=stage/'runtime/python';python_stage.mkdir(parents=True)
 copy_file(Path(sys.executable).resolve(),python_stage/'bin/python3.bin',0o755)
 copy_file(root/'tools/repository/hyperfide-python.sh',python_stage/'bin/python3',0o755)
 stdlib=python_prefix/'lib/python3.14'
 if not(stdlib/'ctypes/__init__.py').is_file():raise SystemExit('hyperfide release: complete Python ctypes standard library is required')
 shutil.copytree(stdlib,python_stage/'lib/python3.14',ignore=shutil.ignore_patterns('site-packages','__pycache__','test','tests'))
 for library in sorted((python_prefix/'lib').glob('libpython3.14*.so*')):
  copy_file(library.resolve(),python_stage/'lib'/library.name,0o755)

 for name in ['install.sh','uninstall.sh','hyperfide-entrypoint.sh','hyperfide-python.sh']:copy_file(root/'tools/repository'/name,stage/'scripts'/name,0o755)
 copy_file(Path('/usr/bin/git').resolve(),stage/'runtime/git',0o755)
 for name in ['inspect-proof.py','check-evidence.py','proof_relocation.py','registry.json','manifest.schema.json']:
  source=root/'tests/hyperfide'/name
  if not source.is_file():raise SystemExit('hyperfide release: actual reviewed proof inspector assets are required')
  copy_file(source,stage/'services/proof'/name,0o644)
 for name in ['package.json','package-lock.json']:copy_file(build/name,stage/'services'/name)
 shutil.copytree(build/'dist',stage/'services/dist')
 shutil.copytree(root/'core/control-plane/components',stage/'services/components')
 migrations=root/'core/control-plane/migrations'
 if migrations.exists():shutil.copytree(migrations,stage/'services/migrations')
 deploy=root/'deploy/hyperfide'
 if deploy.exists():shutil.copytree(deploy,stage/'deploy/hyperfide')
 host=root/'runtime/supervisory_host.py'
 if host.exists():copy_file(host,stage/'services/runtime/supervisory_host.py')
 # ---- hyperfide-v21 2.9: supervision unit qualification marker ----
 # The built deployment/releases.ts stageUnitReceipt ships share/hyperfide/qualified/26.4.json only when the release
 # inspector accepts its pinned digest. Without the receipt the supervisory-host and issue-watcher units ship unstartable.
 # Source order (hyperfide-v21 3.19): HYPERFIDE_RELEASE_UNIT_RECEIPT, the verified local artifacts cache, then the
 # artifact store by tests/hyperfide/evidence-receipts/26.4.json, so a clean host without artifacts/ releases.
 # A tracked receipt the store cannot serve refuses; with no receipt and no cache the units ship unstartable.
 sys.path.insert(0,str(root/'tests/hyperfide'))
 import evidence_store
 override=os.environ.get('HYPERFIDE_RELEASE_UNIT_RECEIPT')
 if override and not Path(override).is_absolute():raise SystemExit('hyperfide release: HYPERFIDE_RELEASE_UNIT_RECEIPT must be an absolute path')
 try:unit_receipt,unit_source=evidence_store.unit_receipt_input(root,temp,override)
 except (evidence_store.EvidenceIntegrityError,evidence_store.EvidenceUnavailable) as exc:raise SystemExit('hyperfide release: 26.4 unit receipt unavailable: '+str(exc))
 if unit_receipt is None:unit_receipt=root/'artifacts/hyperfide/tasks/26.4/evidence-index.json'
 stage_code="const [stage,receipt,source]=process.argv.slice(1);const {stageUnitReceipt}=await import(process.env.HYPERFIDE_RELEASES_MODULE);console.log(JSON.stringify(await stageUnitReceipt(stage,receipt,source)));"
 staged=subprocess.run([str(node),'--input-type=module','-e',stage_code,str(stage),str(unit_receipt),unit_source],env=dict(os.environ,HYPERFIDE_RELEASES_MODULE=(build/'dist/deployment/releases.js').as_uri()),cwd=build,text=True,capture_output=True,timeout=120)
 if staged.returncode:raise SystemExit('hyperfide release: unit qualification receipt refused: '+staged.stderr.strip()[-2000:])
 if not json.loads(staged.stdout.strip().splitlines()[-1])['staged']:print('hyperfide release: warning: no 26.4 unit receipt at '+str(unit_receipt)+'; supervisory-host and issue-watcher ship unstartable',file=sys.stderr)
 # ---- end supervision unit qualification marker ----
 subprocess.run(['npm','ci','--omit=dev','--ignore-scripts'],cwd=stage/'services',check=True)
 # Bundle the actual linked dependencies instead of replacing qualified link flags.
 # glibc's own members stay with the host loader: the relocatable ELF files name the host interpreter, and a bundled libc under a different loader crashes.
 glibc=re.compile(r'ld-linux-x86-64\.so\.2|lib(?:c|m|mvec|pthread|dl|rt|util|resolv|anl|nsl|BrokenLocale|c_malloc_debug|thread_db|nss_[A-Za-z0-9_]+)\.so\.[0-9]+')
 executables=[(root/'hyperfide',stage/'lib/hyperfide'),(root/'build/hyperfide-native',stage/'lib/hyperfide'),(node,stage/'lib/hyperfide'),(Path('/usr/bin/git'),stage/'lib/hyperfide')]+[(item,python_stage/'lib') for item in [Path(sys.executable).resolve()]+sorted((stdlib/'lib-dynload').glob('*.so'))]
 for executable,library_root in executables:
  observed=subprocess.run(['ldd',str(executable)],text=True,capture_output=True)
  if observed.returncode:raise SystemExit('hyperfide release: cannot enumerate native runtime dependencies')
  if 'not found' in observed.stdout:raise SystemExit('hyperfide release: unresolved native runtime dependency')
  for raw in re.findall(r'(?:=>\s+|^\s*)(/[^\s()]+)',observed.stdout,re.M):
   source=Path(raw);target=library_root/source.name
   if glibc.fullmatch(source.name):continue
   if target.exists() and digest(target)!=digest(source):raise SystemExit('hyperfide release: library name collision')
   copy_file(source,target,0o755)
 # npm's executable symlinks become ordinary pinned files in the release contract.
 for item in sorted(stage.rglob('*')):
  if item.is_symlink():
   target=item.resolve()
   if not target.is_file() or not target.is_relative_to(stage):raise SystemExit('hyperfide release: unsafe package link')
   data=target.read_bytes();mode=0o755 if target.stat().st_mode&0o111 else 0o644
   item.unlink();item.write_bytes(data);item.chmod(mode)
 if any(glibc.fullmatch(item.name) for item in stage.rglob('*')):raise SystemExit('hyperfide release: glibc members must come from the host loader, not the bundle')
 for launch_env in [dict(os.environ),dict(os.environ,LD_LIBRARY_PATH=str(stage/'lib/hyperfide'))]:
  launched=subprocess.run([str(stage/'runtime/node'),'--version'],env=launch_env,text=True,capture_output=True,timeout=60)
  if launched.returncode or launched.stdout.strip()!='v24.22.0':raise SystemExit('hyperfide release: bundled node does not run as launched')
 launched=subprocess.run([str(stage/'bin/hyperfide'),'--version'],text=True,capture_output=True,timeout=60)
 if launched.returncode or launched.stdout.strip()!='2.2.0':raise SystemExit('hyperfide release: bundled hyperfide does not run with its bundled libraries')
 probe_env=dict(os.environ,PYTHONHOME=str(python_stage),LD_LIBRARY_PATH=str(stage/'lib/hyperfide'))
 probe_code="import ctypes,os,sys; assert sys.version_info[:3]==(3,14,8); assert os.path.realpath(sys.base_prefix)==os.path.realpath(sys.argv[1]); libc=ctypes.CDLL(None,use_errno=True); value=ctypes.c_int(); assert libc.prctl(36,1,0,0,0)==0; assert libc.prctl(37,ctypes.byref(value),0,0,0)==0 and value.value==1; assert os.access('/proc/self/task/'+str(os.getpid())+'/children',os.R_OK); child=os.fork(); os._exit(0) if child==0 else None; assert os.waitpid(child,0)[0]==child"
 subprocess.run([str(python_stage/'bin/python3'),'-I','-c',probe_code,str(python_stage)],env=probe_env,check=True)
 files=[]
 for item in sorted(stage.rglob('*')):
  if item.is_file():
   mode='0755' if item.stat().st_mode&0o111 else '0644';item.chmod(int(mode,8))
   files.append({'path':item.relative_to(stage).as_posix(),'digest':digest(item),'size_bytes':str(item.stat().st_size),'mode':mode})
 manifest={'schema_version':1,'release_version':'2.2.0','source_commit':commit,'source_date_epoch':epoch,'protocol_version':1,'schema_min':1,'schema_max':1,'runtime':{'node':'24.22.0','npm':'11.19.1','python':'3.14.8','platform':'linux','architecture':'x64'},'files':files}
 encoded=(json.dumps(manifest,sort_keys=True,separators=(',',':'))+'\n').encode()
 (stage/'manifest.json').write_bytes(encoded)
 signature=None
 signing_key=os.environ.get('HYPERFIDE_RELEASE_SIGNING_KEY_FILE')
 if not signing_key:raise SystemExit('hyperfide release: signing key is required')
 if signing_key:
  if not Path(signing_key).is_absolute():raise SystemExit('hyperfide release: signing key must be an absolute private reference')
  fd=os.open(signing_key,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
  try:
   before=os.fstat(fd)
   if not stat.S_ISREG(before.st_mode) or before.st_size>16384 or before.st_mode&0o077 or before.st_uid!=os.geteuid():raise SystemExit('hyperfide release: signing key must be a protected owner file')
   key_bytes=os.read(fd,16385);after=os.fstat(fd)
   if (before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns):raise SystemExit('hyperfide release: signing key changed')
  finally:os.close(fd)
  key_file=temp/'signing-key.pem';key_file.write_bytes(key_bytes);key_file.chmod(0o600)
  verifier='/usr/bin/openssl'
  public=subprocess.run([verifier,'pkey','-in',str(key_file),'-pubout','-outform','DER'],stdin=subprocess.DEVNULL,capture_output=True,timeout=30)
  if public.returncode or len(public.stdout)!=44 or not public.stdout.startswith(bytes.fromhex('302a300506032b6570032100')):raise SystemExit('hyperfide release: configured signing key must be Ed25519')
  signature_file=output/'manifest.sig'
  signed=subprocess.run([verifier,'pkeyutl','-sign','-inkey',str(key_file),'-rawin','-in',str(stage/'manifest.json'),'-out',str(signature_file)],stdin=subprocess.DEVNULL,capture_output=True,timeout=30)
  key_file.unlink()
  if signed.returncode or signature_file.stat().st_size!=64:raise SystemExit('hyperfide release: exact manifest signing failed')
  signature_file.chmod(0o644)
  signature={'algorithm':'ED25519','file':'manifest.sig','key_fingerprint':digest_bytes(public.stdout)}
 manifest_digest=hashlib.sha256(encoded).hexdigest();name='hyperfide-2.2.0-linux-x64-'+manifest_digest[:16]+'.tar.gz'
 archive=output/name
 with archive.open('wb') as raw:
  with gzip.GzipFile(filename='',mode='wb',fileobj=raw,mtime=int(epoch)) as zipped:
   with tarfile.open(fileobj=zipped,mode='w',format=tarfile.GNU_FORMAT) as tar:
    for item in sorted(stage.rglob('*')):
     relative=item.relative_to(stage).as_posix();info=tar.gettarinfo(str(item),arcname=relative)
     info.uid=info.gid=0;info.uname=info.gname='';info.mtime=int(epoch)
     if info.isfile():
      with item.open('rb') as data:tar.addfile(info,data)
     elif info.isdir():tar.addfile(info)
     else:raise SystemExit('hyperfide release: unsupported artifact member')
 index={'schema_version':1,'release_version':manifest['release_version'],'manifest_digest':'sha256:'+manifest_digest,'archive':name,'archive_digest':digest(archive)}
 (output/'manifest.json').write_bytes(encoded)
 if signature:index['signature']=signature
 (output/'release.json').write_text(json.dumps(index,sort_keys=True)+'\n')
 shutil.copyfile(root/'tools/repository/install.sh',output/'install')
 shutil.copyfile(root/'tools/repository/uninstall.sh',output/'uninstall')
 print(json.dumps({'constructed':True,'published':False,'deployment_authorized':False,'source_commit':commit,'manifest_digest':index['manifest_digest'],'files':len(files),'tests_run':bool(int(sys.argv[2])),'output':str(output)}))
PY
tools/repository/release-sign.sh "$HYPERFIDE_RELEASE_SIGNING_KEY_FILE" "$output/release.json" >/dev/null

release_v22_artifacts
tools/repository/release-sign.sh "$HYPERFIDE_RELEASE_SIGNING_KEY_FILE" "$output/SHA256SUMS" >/dev/null
