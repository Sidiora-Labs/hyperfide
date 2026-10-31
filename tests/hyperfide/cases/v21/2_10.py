#!/usr/bin/env python3
"""Task 2.10: provisioner worker errors persist with the intent; install-service reads
the authority database before the pointer swap; release.sh refuses to run without a
signing key and signs release.json. Everything runs in temporary roots against an owned
ephemeral PostgreSQL cluster (the tasks/29_5.py pattern); nothing is published."""
import hashlib,importlib.util,json,os,shutil,subprocess,sys,tempfile,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
SERVICE=ROOT/"core/control-plane"
IDS=[];FAILED=[]

def load(name,relative):
 spec=importlib.util.spec_from_file_location(name,ROOT/relative);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
def expect(v,m="assertion failed"):
 if not v:raise AssertionError(m)
def check(name,fn):
 identity="v21.2_10."+name;IDS.append(identity)
 try:actual=fn() or "observed"
 except Exception as e:actual=type(e).__name__+": "+str(e)[:1500];FAILED.append(identity)
 print(json.dumps({"type":"assertion","id":identity,"expected":"observed","actual":actual}),flush=True)
def sha_bytes(b):return "sha256:"+hashlib.sha256(b).hexdigest()
def ed25519_key(path):
 subprocess.run(["openssl","genpkey","-algorithm","ed25519","-out",str(path)],check=True,capture_output=True);path.chmod(0o600)
def public_pem(key,out):
 subprocess.run(["openssl","pkey","-in",str(key),"-pubout","-out",str(out)],check=True,capture_output=True);out.chmod(0o644)
def verifies(public,data,signature):
 return subprocess.run(["openssl","pkeyutl","-verify","-pubin","-inkey",str(public),"-rawin","-in",str(data),"-sigfile",str(signature)],capture_output=True).returncode==0
def clean_env():
 env=os.environ.copy()
 for key in list(env):
  if key=="DATABASE_URL" or key.startswith("HYPERFIDE_") or key.startswith("HF_"):del env[key]
 return env

# ---- release signing -------------------------------------------------------------
def release_checks(tmp):
 sign=ROOT/"tools/repository/release-sign.sh";key=tmp/"signing.pem";ed25519_key(key);public=tmp/"public.pem";public_pem(key,public)
 index=tmp/"release.json";index.write_text(json.dumps({"schema_version":1,"manifest_digest":"sha256:"+"a"*64})+"\n")
 def signs():
  r=subprocess.run([str(sign),str(key),str(index)],capture_output=True,text=True,timeout=60)
  expect(r.returncode==0,"signer failed: "+r.stderr)
  sig=Path(str(index)+".sig");expect(sig.stat().st_size==64,"signature is not raw Ed25519")
  der=subprocess.run(["openssl","pkey","-in",str(key),"-pubout","-outform","DER"],capture_output=True,check=True).stdout
  expect(r.stdout.strip()==sha_bytes(der),"signer did not report the key fingerprint")
  expect(verifies(public,index,sig),"release.json signature does not verify")
  tampered=tmp/"tampered.json";tampered.write_bytes(index.read_bytes()+b" ")
  expect(not verifies(public,tampered,sig),"signature verified altered bytes")
 check("release.json-signed",signs)
 def bad_keys():
  for label,prepare in [("group-readable",lambda k:k.chmod(0o640)),("relative",None),("missing",lambda k:k.unlink()),("rsa",None)]:
   k=tmp/("bad-"+label+".pem");target=index.with_name("bad-"+label+".json");target.write_text("{}\n")
   if label=="rsa":subprocess.run(["openssl","genpkey","-algorithm","RSA","-pkeyopt","rsa_keygen_bits:2048","-out",str(k)],check=True,capture_output=True);k.chmod(0o600)
   else:ed25519_key(k)
   if prepare:prepare(k)
   arg=os.path.relpath(k) if label=="relative" else str(k)
   r=subprocess.run([str(sign),arg,str(target)],capture_output=True,text=True,timeout=60)
   expect(r.returncode==2 and not Path(str(target)+".sig").exists(),label+" key was accepted: "+r.stderr)
 check("release.sign-refuses-unprotected-or-foreign-keys",bad_keys)
 def requires_key():
  for label,value in [("unset",None),("empty",""),("relative","relative/key.pem"),("absent",str(tmp/"absent.pem"))]:
   p,calls,out=shim_release(tmp,label,value)
   expect(p.returncode==2 and ("HYPERFIDE_RELEASE_SIGNING_KEY_FILE" in p.stderr or "does not exist" in p.stderr),"release ran without a signing key: "+str((value,p.returncode,p.stderr[-400:])))
   expect(calls==[] and not out.exists(),"release did work before refusing: "+str((label,calls)))
 check("release.refuses-without-key-before-make",requires_key)
 def release_signs_index():
  p,calls,out=shim_release(tmp,"signed",str(key))
  expect(p.returncode==0,"shimmed release failed: "+p.stderr[-800:])
  expect([c.split()[0] for c in calls]==["make","stage"],"release did not build before staging: "+str(calls))
  expect(verifies(public,out/"release.json",out/"release.json.sig"),"release.sh did not sign the release.json its stage wrote")
 check("release.signs-index-after-build",release_signs_index)

def shim_release(tmp,label,key):
 """Runs scripts/release.sh itself in a clean scratch checkout. The full build needs the pinned remote
 toolchain, so make and the Python stage are shims that log each call; the stage shim writes release.json
 as the real stage does. Returns the process, the logged calls and the output directory."""
 repo=tmp/("repo-"+label);(repo/"tools/repository").mkdir(parents=True)
 for name in ["release.sh","release-sign.sh"]:shutil.copy2(ROOT/"tools/repository"/name,repo/"tools/repository"/name)
 vcs=["git","-c","user.name=fixture","-c","user.email=fixture@example.invalid","-C",str(repo)]
 for argv in [["init","-q"],["add","-A"],["commit","-qm","fixture"]]:subprocess.run(vcs+argv,check=True,capture_output=True)
 shims=tmp/("shims-"+label);shims.mkdir();log=tmp/("calls-"+label)
 (shims/"make").write_text('#!/bin/sh\necho "make $*" >> "$RELEASE_SHIM_LOG"\nprintf \'#!/bin/sh\\necho 2.0.0-dev\\n\' > hyperfide\nchmod 755 hyperfide\n')
 (shims/"python3").write_text('#!/bin/sh\ncat >/dev/null\necho "stage $2" >> "$RELEASE_SHIM_LOG"\nmkdir -p "$2"\nprintf \'%s\\n\' "$RELEASE_SHIM_INDEX" > "$2/release.json"\n')
 for shim in shims.iterdir():shim.chmod(0o755)
 out=tmp/("release-out-"+label);env=clean_env()
 env.update(PATH=str(shims)+os.pathsep+env.get("PATH",""),RELEASE_SHIM_LOG=str(log),HYPERFIDE_BUILD_PLACEMENT="remote",RELEASE_SHIM_INDEX=json.dumps({"schema_version":1,"manifest_digest":"sha256:"+"b"*64}))
 if key is not None:env["HYPERFIDE_RELEASE_SIGNING_KEY_FILE"]=key
 p=subprocess.run(["bash",str(repo/"tools/repository/release.sh"),"--output",str(out),"--skip-tests"],cwd=tmp,env=env,capture_output=True,text=True,timeout=120)
 return p,(log.read_text().splitlines() if log.exists() else []),out

def sign_index(auth,key,manifest_digest,release_version="2.0.0-dev"):
 """release.json beside manifest.sig, shaped as scripts/release.sh writes it and signed by scripts/release-sign.sh."""
 fingerprint=subprocess.run([str(ROOT/"tools/repository/release-sign.sh"),"--check-key",str(key)],capture_output=True,text=True,check=True).stdout.strip()
 index={"schema_version":1,"release_version":release_version,"manifest_digest":manifest_digest,"archive":"hyperfide-"+release_version+"-linux-x64-"+manifest_digest[7:23]+".tar.gz","archive_digest":"sha256:"+"0"*64,"signature":{"algorithm":"ED25519","file":"manifest.sig","key_fingerprint":fingerprint}}
 target=auth/"release.json";target.write_text(json.dumps(index,sort_keys=True)+"\n");target.chmod(0o644)
 subprocess.run([str(ROOT/"tools/repository/release-sign.sh"),str(key),str(target)],capture_output=True,text=True,check=True)
 return target

# ---- install-service -------------------------------------------------------------
def build_release(base):
 payload=base/"release";payload.mkdir()
 placeholders={"bin/hyperfide":b"#!/bin/sh\necho hyperfide\n","bin/cg":b"#!/bin/sh\necho hyperfide\n","bin/hyperfide-native":b"native\n","runtime/node":b"node\n",
  "runtime/python/bin/python3":b"python\n","runtime/python/bin/python3.bin":b"python\n","runtime/python/lib/python3.14/ctypes/__init__.py":b"\n","lib/hyperfide/libplaceholder.so":b"lib\n"}
 for name,data in placeholders.items():p=payload/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data)
 (payload/"services").mkdir()
 for name in ["package.json","package-lock.json"]:shutil.copyfile(SERVICE/name,payload/"services"/name)
 # Only the import closure the installer loads, plus the required role entry points: the
 # installer fsyncs every staged file, so a full dist makes staging minutes long.
 import re
 pending=["deployment/releases.js","storage/runtime.js","storage/durability.js","control.js","provisioner.js","dispatch.js"];seen=set()
 while pending:
  name=pending.pop()
  if name in seen:continue
  seen.add(name);source=SERVICE/"dist"/name;target=payload/"services/dist"/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
  if name in ("control.js","provisioner.js","dispatch.js"):continue
  for spec in re.findall(r"""(?:from|import)\s*\(?\s*['"](\.{1,2}/[^'"]+)['"]""",source.read_text()):
   pending.append(os.path.normpath(os.path.join(os.path.dirname(name),spec)))
 # Production closure of pg, the only package the installer's authority read loads; queried
 # where node_modules really lives so a worktree's linked node_modules resolves the same.
 packages=(SERVICE/"node_modules").resolve().parent
 for item in json.loads(subprocess.check_output(["npm","query","#pg, #pg *"],cwd=packages,text=True)):
  shutil.copytree(packages/item["location"],payload/"services"/item["location"],dirs_exist_ok=True,symlinks=False,ignore=lambda d,names,top=packages/item["location"]:["node_modules"] if Path(d)==top else [])
 deploy=payload/"deploy/hyperfide";deploy.mkdir(parents=True)
 for name in ["install-service.mjs","dist-stamp.mjs","control.service","provisioner.service","dispatch.service"]:shutil.copyfile(ROOT/"deploy/hyperfide"/name,deploy/name)
 for d,_,files in os.walk(payload):
  os.chmod(d,0o755)
  for f in files:p=Path(d)/f;p.chmod(0o755 if p.relative_to(payload).as_posix().startswith(("bin/","runtime/node","runtime/python/bin/")) else 0o644)
 files=[{"path":p.relative_to(payload).as_posix(),"digest":sha_bytes(p.read_bytes()),"size_bytes":str(p.stat().st_size),"mode":format(p.stat().st_mode&0o777,"04o")} for p in sorted(payload.rglob("*")) if p.is_file()]
 commit=subprocess.check_output(["git","rev-parse","HEAD"],cwd=ROOT,text=True).strip()
 manifest={"schema_version":1,"release_version":"2.0.0-dev","source_commit":commit,"source_date_epoch":"1","protocol_version":1,"schema_min":1,"schema_max":1,"runtime":{"node":"24.22.0","npm":"11.19.1","python":"3.14.8","platform":"linux","architecture":"x64"},"files":files}
 mf=payload/"manifest.json";mf.write_text(json.dumps(manifest));mf.chmod(0o644)
 auth=base/"auth";auth.mkdir(mode=0o755);key=base/"signing.pem";ed25519_key(key);public=auth/"trusted.pem";public_pem(key,public)
 signature=auth/"manifest.sig";signature.write_bytes(subprocess.check_output(["openssl","pkeyutl","-sign","-rawin","-inkey",str(key),"-in",str(mf)]));signature.chmod(0o644)
 sign_index(auth,key,sha_bytes(mf.read_bytes()))
 return payload,public,signature,sha_bytes(mf.read_bytes())

def install_checks(base,cluster,database_url):
 payload,public,signature,digest=build_release(base)
 destination=base/"service-root"
 argv=["node",str(payload/"deploy/hyperfide/install-service.mjs"),"--release-root",str(payload),"--destination-root",str(destination),"--trusted-key",str(public),"--signature-file",str(signature),"--manifest-digest",digest,"--service-uid","33025","--service-gid","33025","--promote"]
 deployment=str(uuid.uuid4())
 def run(url):
  env=clean_env();env["HYPERFIDE_DEPLOYMENT_ID"]=deployment
  if url:env["DATABASE_URL"]=url
  p=subprocess.run(argv,cwd=base,env=env,capture_output=True,text=True,timeout=600)
  lines=p.stdout.strip().splitlines();expect(len(lines)==1,"installer did not emit one receipt: "+p.stdout+p.stderr[-800:])
  return p.returncode,json.loads(lines[0])
 current=destination/"current"
 def no_database_refuses_before_swap():
  code,r=run(None)
  expect(code==78 and r["outcome"]=="REFUSED","database failure was not a clean refusal: "+json.dumps(r))
  # The refusal must come from the authority read itself, after a verified staged release.
  reason=r["error"]["code"]
  expect(reason=="INSTALL_AUTHORITY_UNREADABLE" or not reason.startswith(("INSTALL_","ERR_")),"refused before the authority read: "+reason)
  expect((destination/"releases"/digest[7:]).is_dir(),"release was not staged before the authority read")
  expect(not current.exists() and not current.is_symlink(),"pointer was swapped before the authority read")
  return "observed: refused with "+reason
 check("install.unreadable-database-refuses-before-swap",no_database_refuses_before_swap)
 def reachable_database_promotes():
  code,r=run(database_url)
  expect(code==0 and r["outcome"]=="SUCCEEDED" and r["promoted"] is True and r["authority_activated"] is False,"promotion with a readable database failed: "+json.dumps(r))
  expect(current.resolve()==Path(r["release_directory"]),"pointer differs from the installed release")
  expect(json.loads((destination/"service-installation.json").read_text())["authority_activated"] is False,"receipt lacks the authority state read")
 check("install.readable-database-promotes",reachable_database_promotes)
 def failure_preserves_pointer():
  before=os.readlink(current);receipt=(destination/"service-installation.json").read_bytes()
  code,r=run("postgresql://nobody@localhost:5432/absent?host="+str(base/"no-socket"))
  expect(code==78 and r["outcome"]=="REFUSED","unreachable database after a promotion was not refused: "+json.dumps(r))
  expect(os.readlink(current)==before and (destination/"service-installation.json").read_bytes()==receipt,"refused install changed the pointer or receipt")
 check("install.unreachable-database-preserves-pointer",failure_preserves_pointer)

# ---- provisioner worker error persistence ----------------------------------------
def worker_checks(folder,admin_url):
 os.environ["DATABASE_URL"]=admin_url
 base=load("provider_intents","tests/hyperfide/cases/tasks/8_3.py")
 module=base.simulated_module_root(folder)
 adapter=base.SIMULATED_ADAPTER.replace(" a.list=async op=>{\n  log(op);"," a.list=async op=>{\n  log(op);if(read().list_fails)throw new Error('simulated inventory outage');")
 expect(adapter!=base.SIMULATED_ADAPTER,"simulated adapter shape changed; update the list-failure hook")
 (module/"fixtures/simulated-provider.js").write_text(adapter)
 state=Path(folder)/"provider-state.json"
 def configure(**v):
  s=json.loads(state.read_text());s.update(v);state.write_text(json.dumps(s))
 state.write_text(json.dumps({"resources":{},"calls":[],"create_mode":"lose","list_fails":True,"incompatible":False}))
 def setup(fx):
  base.prepare_provider_intent_fixture(fx)
  (fx.components/"8.3-simulated-adapter.json").write_text(json.dumps(base.SIMULATED_FRAGMENT))
  fx.executor=fx.path/"worker.json"
  fx.executor.write_text(json.dumps({"schema_version":1,"principals":[{"credential_id":fx.ids["provisioner"],"key_path":str(fx.keys["provisioner"]["path"])}],"concurrency":1}));fx.executor.chmod(0o600)
  fx.env.update(HF_PROVISIONER_EXECUTOR_CONFIG_FILE=str(fx.executor),HF_SIMULATED_PROVIDER_STATE=str(state),HYPERFIDE_PROVISIONER_POLL_MS="100",HYPERFIDE_PROVISIONER_RETRY_MS="200",HYPERFIDE_PROVISIONER_LEASE_MS="1000")
  fx.declarations=fx.path/"declarations.json";fx.env["HYPERFIDE_CAPACITY_ATTESTATIONS"]=str(fx.declarations)
 f=base.SimulatedProvisionerFixture(module,extra_components=["8.2","8.3"],extra_setup=setup,extra_actions=["provider.simulated.describe"])
 try:
  def result(action,input=None,key="operator",component="8.3"):
   status,r=f.invoke(action,input or {},key=key,component=component)
   expect(status==200 and r.get("ok") is True,(status,r));return r["result"]
  org,run=f.ids["organisation"],f.ids["run"]
  expect(result("provider.pools.configure",component="8.2")["configured"]==1,"pool not configured")
  raw=b"Owned 2.10 component declaration";aid=str(uuid.uuid4());proof=f.path/"capacity-proof";proof.write_bytes(raw);digest=base.sha(raw)
  f.sql("INSERT INTO hyperfide.artifacts(organisation_id,run_id,id,digest,size_bytes,storage_backend,storage_key,status,completed_at) VALUES($1,$2,$3,$4,$5,'COMPONENT_FIXTURE',$6,'COMPLETE',clock_timestamp())",[org,run,aid,digest,str(len(raw)),str(proof)])
  cfg=f.sql("SELECT configuration_digest FROM hyperfide.provider_pool_configurations WHERE organisation_id=$1 AND pool_id=$2 AND active",[org,f.pool])[0]["configuration_digest"]
  f.declarations.write_text(json.dumps({"schema_version":1,"organisation_id":org,"attestations":[{"id":str(uuid.uuid4()),"pool_id":f.pool,"configuration_digest":cfg,"scope_kind":"ACCOUNT","scope_key":"fixture-account","dimension":"SANDBOX","limit":"10","declared_at":base.utc(-1000),"expires_at":base.utc(60000),"provenance":{"run_id":run,"artifact_id":aid,"digest":digest}}]}));f.declarations.chmod(0o600)
  result("provider.pools.attest-capacity",component="8.2")
  base.seed_provider_capacity(f)
  request={"run_id":run,"pool_id":f.pool,"sandbox_id":str(uuid.uuid4()),"request_key":str(uuid.uuid4()),"deadline_at":base.utc(),"reservation_ids":f.reservations,"profile_id":f.profile,"preparation_digest":f.preparation,"purpose":"PREPARATION"}
  intent=result("provider.intents.prepare-create",request)["intent"]["id"]
  def row():return f.sql("SELECT state,failure_code FROM hyperfide.provisioning_intents WHERE organisation_id=$1 AND id=$2",[org,intent])[0]
  def persisted():
   r=base.wait_for(lambda:(lambda x:x if x["failure_code"]=="WORKER_INTENT_FAILED" else None)(row()),"worker error never reached the intent row")
   expect(r["state"] not in ("QUARANTINED","TERMINAL","REJECTED"),r)
  check("worker.error-persisted-on-intent",persisted)
  def survives_restart():
   f.stop();f.start()
   errors=result("provider.worker.status")["errors"]
   expect(errors.get(intent)=="WORKER_INTENT_FAILED","restarted worker status lost the persisted error: "+json.dumps(errors))
  check("worker.error-survives-restart",survives_restart)
  def quarantine_keeps_reconciler_code():
   configure(list_fails=False)
   r=base.wait_for(lambda:(lambda x:x if x["state"]=="QUARANTINED" else None)(row()),"intent never reached quarantine")
   expect(r["failure_code"]=="OWNERSHIP_UNVERIFIED","worker overwrote the reconciler's quarantine code: "+json.dumps(r))
  check("worker.quarantine-code-preserved",quarantine_keeps_reconciler_code)
  f.stop()
 finally:f.close()

def main():
 # The installer chowns to the service uid and the owned cluster starts through runuser, so a non-root host cannot
 # prove the install behaviour; it skips under the tests/run.sh contract instead of recording a pass.
 if os.geteuid()!=0:print("SKIP: installer and owned cluster require the root operator",flush=True);return 77
 cases=load("hf_29_5","tests/hyperfide/cases/tasks/29_5.py")
 # A client-only PostgreSQL package can be the newest version directory; use one that ships a server.
 servers=sorted((p for p in Path("/usr/lib/postgresql").glob("*/bin") if (p/"initdb").is_file()),key=lambda p:int(p.parent.name))
 if servers and not os.environ.get("HYPERFIDE_PG_BIN"):os.environ["HYPERFIDE_PG_BIN"]=str(servers[-1])
 if not servers and not os.environ.get("HYPERFIDE_PG_BIN"):print("SKIP: no PostgreSQL server binaries");return 77
 try:cases.postgres_bin()
 except AssertionError as e:print("SKIP: "+str(e));return 77
 stamp=subprocess.run(["node",str(ROOT/"deploy/hyperfide/dist-stamp.mjs"),"check",str(SERVICE)],capture_output=True,text=True)
 if stamp.returncode:print(json.dumps({"type":"error","detail":"core/control-plane/dist is stale; run npm run build: "+stamp.stdout+stamp.stderr}));return 1
 Path("/tmp/hyperfide").mkdir(parents=True,exist_ok=True)
 with tempfile.TemporaryDirectory(prefix="hf-v21-2-10-",dir="/tmp/hyperfide") as tmp:
  tmp=Path(tmp);tmp.chmod(0o755)
  signing=tmp/"release-sign";signing.mkdir();release_checks(signing)
  cluster=cases.Cluster()
  try:
   cluster.sql("CREATE DATABASE "+cases.DATABASE,database="postgres")
   # Disposable cluster: durability is not under test, and the fixture's 30 s migration
   # deadline is otherwise missed on a loaded host.
   for setting in ["fsync=off","full_page_writes=off"]:cluster.sql("ALTER SYSTEM SET "+setting,database="postgres")
   cluster.sql("SELECT pg_reload_conf()",database="postgres")
   install=tmp/"install";install.mkdir(mode=0o755);install.chmod(0o755)
   install_checks(install,cluster,cluster.url(cases.SUPERUSER))
   worker=tmp/"worker";worker.mkdir()
   try:worker_checks(str(worker),cluster.url(cases.SUPERUSER))
   except Exception as e:
    IDS.append("v21.2_10.worker.fixture");FAILED.append("v21.2_10.worker.fixture")
    print(json.dumps({"type":"assertion","id":"v21.2_10.worker.fixture","expected":"observed","actual":type(e).__name__+": "+str(e)[:1500]}),flush=True)
  finally:
   closed=cluster.close()
 print(json.dumps({"type":"summary","assertions":len(IDS),"failed":FAILED,"cluster_removed":closed}),flush=True)
 return 1 if FAILED or not closed else 0

if __name__=="__main__":sys.exit(main())
