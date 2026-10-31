#!/usr/bin/env python3
"""hyperfide-v21 3.22: release signatures are verified before a release is used.
A scratch Ed25519 key made here signs a release (manifest.sig and release.json.sig); install-service
installs it against an owned ephemeral PostgreSQL cluster; a tampered release.json, a missing .sig, a
wrong trusted key and a stale index are each refused with a named error by the installer and by the
release inspector; release.sh with a missing key file fails before make runs. No owner key is read."""
import importlib.util,json,os,shutil,subprocess,sys,tempfile,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
SERVICE=ROOT/"core/control-plane"
IDS=[];FAILED=[]

def load(name,relative):
 spec=importlib.util.spec_from_file_location(name,ROOT/relative);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
release=load("hf_v21_2_10","tests/hyperfide/cases/v21/2_10.py")
def expect(v,m="assertion failed"):
 if not v:raise AssertionError(m)
def check(name,fn):
 identity="v21.3_22."+name;IDS.append(identity)
 try:actual=fn() or "observed"
 except Exception as e:actual=type(e).__name__+": "+str(e)[:1500];FAILED.append(identity)
 print(json.dumps({"type":"assertion","id":identity,"expected":"observed","actual":actual}),flush=True)

def ensure_dist():
 stamp=subprocess.run(["node",str(ROOT/"deploy/hyperfide/dist-stamp.mjs"),"check",str(SERVICE)],capture_output=True,text=True,timeout=120)
 if stamp.returncode==0 and json.loads(stamp.stdout).get("fresh"):return
 built=subprocess.run(["npm","run","build"],cwd=SERVICE,capture_output=True,text=True,timeout=900)
 if built.returncode:raise SystemExit("services dist could not be built: "+built.stdout[-2000:]+built.stderr[-2000:])

def key_gate_checks(tmp):
 key=tmp/"scratch-signing.pem";release.ed25519_key(key);public=tmp/"scratch-public.pem";release.public_pem(key,public)
 def missing_key_before_make():
  p,calls,out=release.shim_release(tmp,"missing-key",str(tmp/"no-such-key.pem"))
  expect(p.returncode==2 and "does not exist" in p.stderr,"missing key file was not refused by the key gate: "+str((p.returncode,p.stderr[-400:])))
  expect(calls==[] and not out.exists(),"release ran make or staged before refusing a missing key: "+str(calls))
 check("release.missing-key-file-fails-before-make",missing_key_before_make)
 def unprotected_key_before_make():
  loose=tmp/"loose.pem";release.ed25519_key(loose);loose.chmod(0o644)
  p,calls,out=release.shim_release(tmp,"loose-key",str(loose))
  expect(p.returncode==2 and "protected owner file" in p.stderr and calls==[],"group-readable key passed the gate: "+str((p.returncode,calls,p.stderr[-400:])))
 check("release.unprotected-key-fails-before-make",unprotected_key_before_make)
 def signed_release():
  p,calls,out=release.shim_release(tmp,"scratch-signed",str(key))
  expect(p.returncode==0 and [c.split()[0] for c in calls]==["make","stage"],"release with a protected scratch key failed: "+str((calls,p.stderr[-600:])))
  expect(release.verifies(public,out/"release.json",out/"release.json.sig"),"release.json.sig does not verify against the scratch key")
 check("release.scratch-key-signs-release-json",signed_release)

def run_install(argv,database_url=None,deployment=None):
 env=release.clean_env();env["HYPERFIDE_DEPLOYMENT_ID"]=deployment or str(uuid.uuid4())
 if database_url:env["DATABASE_URL"]=database_url
 p=subprocess.run(argv,env=env,capture_output=True,text=True,timeout=600)
 lines=p.stdout.strip().splitlines();expect(len(lines)==1,"installer did not emit one receipt: "+p.stdout+p.stderr[-800:])
 return p.returncode,json.loads(lines[0])

def inspect(payload,public,signature):
 code=("const m=await import(process.env.RELEASES_MODULE);try{const r=await m.inspectPrebuiltRelease({HYPERFIDE_RELEASE_ROOT:process.argv[1],"
  "HYPERFIDE_TRUSTED_RELEASE_KEY_FILE:process.argv[2],HYPERFIDE_RELEASE_SIGNATURE_FILE:process.argv[3]},'manifest.json');"
  "console.log(JSON.stringify({ok:true,status:r.signature_status,index:r.release_index}));}catch(e){console.log(JSON.stringify({ok:false,code:e.code,message:e.message}));}")
 p=subprocess.run(["node","--input-type=module","-e",code,str(payload),str(public),str(signature)],capture_output=True,text=True,timeout=120,
  env=dict(os.environ,RELEASES_MODULE=(payload/"services/dist/deployment/releases.js").as_uri()))
 expect(p.returncode==0,p.stderr[-800:]);return json.loads(p.stdout.strip().splitlines()[-1])

def install_checks(base,database_url):
 payload,public,signature,digest=release.build_release(base)
 auth=public.parent;index=auth/"release.json";index_sig=auth/"release.json.sig";key=base/"signing.pem"
 def argv(destination,trusted=public,promote=True):
  return ["node",str(payload/"deploy/hyperfide/install-service.mjs"),"--release-root",str(payload),"--destination-root",str(destination),"--trusted-key",str(trusted),
          "--signature-file",str(signature),"--manifest-digest",digest,"--service-uid","33025","--service-gid","33025"]+(["--promote"] if promote else [])
 def installs():
  inspected=inspect(payload,public,signature)
  expect(inspected["ok"] and inspected["status"]=="VERIFIED" and inspected["index"]["digest"]==release.sha_bytes(index.read_bytes()),"inspector did not verify the signed index: "+json.dumps(inspected))
  destination=base/"installed";code,r=run_install(argv(destination),database_url)
  expect(code==0 and r["outcome"]=="SUCCEEDED" and r["promoted"] is True and r["manifest_digest"]==digest,"signed release did not install: "+json.dumps(r))
  expect((destination/"current").resolve()==Path(r["release_directory"]),"pointer differs from the installed release")
 check("install.signed-release-installs",installs)
 def refused(label,expected,trusted=public):
  destination=base/("refused-"+label);code,r=run_install(argv(destination,trusted),database_url)
  expect(code==78 and r["outcome"]=="REFUSED" and r["error"]["code"]==expected,label+": installer did not refuse with "+expected+": "+json.dumps(r))
  expect(not destination.exists(),label+": installer touched the destination before refusing")
  inspected=inspect(payload,trusted,signature)
  expect(not inspected["ok"] and inspected["code"]==expected,label+": inspector did not refuse with "+expected+": "+json.dumps(inspected))
  return "observed: "+expected
 def tampered():
  original=index.read_bytes();index.write_bytes(original.replace(b'"schema_version": 1',b'"schema_version": 1 '))
  expect(index.read_bytes()!=original,"tamper did not change release.json")
  try:return refused("tampered",'RELEASE_SIGNATURE_FORGED')
  finally:index.write_bytes(original)
 check("refuse.tampered-release-json",tampered)
 def missing_sig():
  moved=auth/"release.json.sig.moved";index_sig.rename(moved)
  try:return refused("missing-sig","RELEASE_SIGNATURE_MISSING")
  finally:moved.rename(index_sig)
 check("refuse.missing-release-json-sig",missing_sig)
 def wrong_key():
  other=base/"other-signing.pem";release.ed25519_key(other);other_public=auth/"other-trusted.pem";release.public_pem(other,other_public)
  return refused("wrong-key","RELEASE_SIGNATURE_FORGED",other_public)
 check("refuse.wrong-trusted-key",wrong_key)
 def stale():
  original=index.read_bytes();original_sig=index_sig.read_bytes()
  release.sign_index(auth,key,"sha256:"+"c"*64)
  try:return refused("stale","RELEASE_SIGNATURE_STALE")
  finally:index.write_bytes(original);index_sig.write_bytes(original_sig)
 check("refuse.stale-index-for-another-manifest",stale)
 def restored():
  inspected=inspect(payload,public,signature)
  expect(inspected["ok"] and inspected["status"]=="VERIFIED","restored release no longer verifies: "+json.dumps(inspected))
 check("inspect.restored-release-verifies",restored)

def main():
 if os.geteuid()!=0:print("SKIP: install-service requires the root operator",flush=True);return 77
 cases=load("hf_29_5","tests/hyperfide/cases/tasks/29_5.py")
 servers=sorted((p for p in Path("/usr/lib/postgresql").glob("*/bin") if (p/"initdb").is_file()),key=lambda p:int(p.parent.name))
 if servers and not os.environ.get("HYPERFIDE_PG_BIN"):os.environ["HYPERFIDE_PG_BIN"]=str(servers[-1])
 if not servers and not os.environ.get("HYPERFIDE_PG_BIN"):print("SKIP: no PostgreSQL server binaries",flush=True);return 77
 try:cases.postgres_bin()
 except AssertionError as e:print("SKIP: "+str(e),flush=True);return 77
 ensure_dist()
 Path("/tmp/hyperfide").mkdir(parents=True,exist_ok=True)
 closed=True
 with tempfile.TemporaryDirectory(prefix="hf-v21-3-22-",dir="/tmp/hyperfide") as tmp:
  tmp=Path(tmp);tmp.chmod(0o755)
  gate=tmp/"gate";gate.mkdir();key_gate_checks(gate)
  cluster=cases.Cluster()
  try:
   cluster.sql("CREATE DATABASE "+cases.DATABASE,database="postgres")
   install=tmp/"install";install.mkdir(mode=0o755);install.chmod(0o755)
   install_checks(install,cluster.url(cases.SUPERUSER))
  finally:
   closed=cluster.close()
 print(json.dumps({"type":"summary","assertions":len(IDS),"failed":FAILED,"cluster_removed":closed}),flush=True)
 return 1 if FAILED or not closed else 0

if __name__=="__main__":sys.exit(main())
