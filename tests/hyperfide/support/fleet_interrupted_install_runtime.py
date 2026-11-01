"""Actual immutable Node/npm/native files and authored package inputs for recipe interruption."""
from __future__ import annotations
import hashlib,json,os,re,shutil,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
PACKAGE={'name':'hyperfide-interrupted-install-fixture','version':'1.0.0','private':True,'scripts':{'postinstall':'node postinstall.mjs'}}
LOCK={'name':PACKAGE['name'],'version':'1.0.0','lockfileVersion':3,'requires':True,'packages':{'':{'name':PACKAGE['name'],'version':'1.0.0','hasInstallScript':True}}}
POSTINSTALL=b"import fs from 'node:fs';\nimport path from 'node:path';\nconst marker=path.join(process.env.TMPDIR,'interrupted-install-ready');\nif(!fs.existsSync(marker)){fs.writeFileSync(marker,'actual dependency lifecycle reached\\n');setInterval(()=>{},1000);}else{console.log('actual dependency lifecycle resumed');}\n"
BASELINE_FILES={'README.md':b'Authored isolated installation input.\n','package.json':(json.dumps(PACKAGE,sort_keys=True)+'\n').encode(),'package-lock.json':(json.dumps(LOCK,sort_keys=True)+'\n').encode(),'postinstall.mjs':POSTINSTALL}
def pin(file):return 'sha256:'+hashlib.sha256(Path(file).read_bytes()).hexdigest()
def prepare_runtime(base,control_dist=None,*,native_source=None,native_digest=None):
 base=Path(base);base.mkdir(mode=0o755,parents=True,exist_ok=True);base.chmod(0o755)
 source_node=Path(shutil.which('node')).resolve();source_npm=source_node.parents[1]/'lib/node_modules/npm'
 if not (source_npm/'bin/npm-cli.js').is_file():raise RuntimeError('Actual pinned Node distribution npm is required')
 shutil.copytree(Path(control_dist) if control_dist else ROOT/'core/control-plane/dist',base/'control',ignore=shutil.ignore_patterns('node_modules'));shutil.copytree(ROOT/'core/control-plane/node_modules',base/'control/node_modules');shutil.copytree(source_npm,base/'npm')
 node=base/'node';shutil.copyfile(source_node,node)
 if native_source is None:
  native_source=ROOT/'build/fleet/integration/private/retained-hyperfide-native-695cbd2b'
  native_digest='sha256:695cbd2b781da4d81575b27d9b6016d2d1410189b7244bbe4d14b8c87154c6d8'
 if not native_digest or pin(native_source)!=native_digest:raise RuntimeError('Explicit immutable native digest required')
 native=base/'hyperfide-native';shutil.copyfile(native_source,native)
 (base/'control/package.json').write_text('{"type":"module"}\n')
 for directory,_,files in os.walk(base):
  os.chmod(directory,0o755)
  for name in files:os.chmod(Path(directory)/name,0o444)
 for file in [node,native,base/'npm/bin/npm-cli.js']:file.chmod(0o555)
 closure=['preparation/fleet_readiness_probe.js','preparation/fleet_readiness_contract.js','preparation/fleet_install_inventory.js','preparation/fleet_toolchains.js','preparation/fleet_configurations.js','preparation/fleet_client.js','transport/protocol.js','policy/programme.js','contracts/fleet/index.mjs']
 module_closure=[{'path':str(base/'control'/name),'digest':pin(base/'control'/name)} for name in closure]
 pending=[base/'control'/name for name in closure+['preparation/fleet_install.js','preparation/fleet_source.js','preparation/fleet_source_cache.js','preparation/fleet_interfaces.js','preparation/fleet_isolation.js','preparation/fleet_mounts.js']];modules=set()
 while pending:
  file=pending.pop().resolve()
  if file in modules:continue
  if not file.is_relative_to((base/'control').resolve()) or not file.is_file():raise RuntimeError('Release import escapes pinned runtime')
  modules.add(file)
  for specifier in re.findall(r'''(?:from\s*|import\s*\(?\s*)["']([^"']+)["']''',file.read_text()):
   if specifier.startswith('.'):
    dependency=(file.parent/specifier).resolve()
    if dependency.suffix in ['.js','.mjs']:pending.append(dependency)
 runtime_files=[{'path':str(file),'digest':pin(file)} for file in sorted(modules)]
 return {'root':str(base),'node_path':str(node),'node_version':subprocess.check_output([str(node),'--version'],text=True).strip().lstrip('v'),'npm_path':str(base/'npm/bin/npm-cli.js'),'npm_version':json.loads((base/'npm/package.json').read_text())['version'],'native_path':str(native),'native_digest':pin(native),'recipe_path':str(base/'control/preparation/fleet_install.js'),'recipe_digest':pin(base/'control/preparation/fleet_install.js'),'runtime_files':runtime_files,'module_closure':module_closure,'image_digest':'sha256:'+hashlib.sha256(json.dumps(runtime_files,sort_keys=True).encode()).hexdigest()}
