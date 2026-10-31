#!/usr/bin/env python3
"""Stale-dist guard: the service build stamps dist with a source digest, and
install-service.mjs and the release build refuse a dist that no longer matches
its source. The build runs in a temporary copy laid out like the checkout (and
like release.sh's build tree), so tampering never touches the real source."""
import json,os,pathlib,shutil,subprocess,sys,tempfile
ROOT=pathlib.Path(__file__).resolve().parents[4]
SERVICE=ROOT/"core/control-plane"
IDS=[];FAILED=[];SKIPPED=[]

def expect(v,m="assertion failed"):
 if not v:raise AssertionError(m)
def check(name,fn):
 identity="dist.stamp."+name;IDS.append(identity)
 try:actual=fn() or "observed"
 except Exception as e:actual=type(e).__name__+": "+str(e);FAILED.append(identity)
 if isinstance(actual,str) and actual.startswith("SKIP"):SKIPPED.append(identity)
 print(json.dumps({"type":"assertion","id":identity,"expected":"observed","actual":actual}),flush=True)

def stamp(mode,service):
 return subprocess.run(["node",str(service.parents[1]/"deploy/hyperfide/dist-stamp.mjs"),mode,str(service)],text=True,capture_output=True,timeout=120)

def install(base,inputs):
 """Runs the checkout's installer with well-formed arguments; returns the refusal code."""
 args=["node",str(base/"deploy/hyperfide/install-service.mjs"),"--release-root",str(inputs/"release"),"--destination-root",str(inputs/"destination"),"--trusted-key",str(inputs/"key.pem"),"--signature-file",str(inputs/"manifest.sig"),"--manifest-digest","sha256:"+"0"*64,"--service-uid","33025","--service-gid","33025"]
 r=subprocess.run(args,text=True,capture_output=True,timeout=120)
 out=json.loads(r.stdout.strip().splitlines()[-1])
 expect(out["outcome"]=="REFUSED" and r.returncode==78,"installer did not refuse: "+r.stdout+r.stderr)
 return out["error"]["code"]

def main():
 with tempfile.TemporaryDirectory(prefix="hf-v21-1-4-") as tmp:
  base=pathlib.Path(tmp);base.chmod(0o755)
  service=base/"core/control-plane";service.mkdir(parents=True)
  for name in ["package.json","package-lock.json","tsconfig.json"]:shutil.copyfile(SERVICE/name,service/name)
  shutil.copytree(SERVICE/"src",service/"src")
  (service/"node_modules").symlink_to(SERVICE/"node_modules",target_is_directory=True)
  (base/"deploy/hyperfide").mkdir(parents=True)
  for name in ["dist-stamp.mjs","install-service.mjs"]:shutil.copyfile(ROOT/"deploy/hyperfide"/name,base/"deploy/hyperfide"/name)
  for d,_,_ in os.walk(base):os.chmod(d,0o755)
  inputs=base/"inputs";(inputs/"release").mkdir(parents=True);(inputs/"destination").mkdir()
  for name in ["key.pem","manifest.sig"]:(inputs/name).write_bytes(b"not a key\n");(inputs/name).chmod(0o644)
  as_root=os.geteuid()==0

  def checkout_dist_rebuilt():
   expect((SERVICE/"dist/recovery/bootstrap_fence.js").is_file(),"checkout dist lacks recovery/bootstrap_fence.js")
   r=stamp("check",SERVICE);expect(r.returncode==0 and json.loads(r.stdout)["fresh"],"checkout dist is not fresh: "+r.stdout+r.stderr)
  check("checkout-dist-fresh",checkout_dist_rebuilt)

  def build():
   r=subprocess.run(["npm","run","build"],cwd=service,text=True,capture_output=True,timeout=600)
   expect(r.returncode==0,"build failed: "+r.stdout[-2000:]+r.stderr[-2000:])
   expect((service/"dist/recovery/bootstrap_fence.js").is_file(),"build did not emit recovery/bootstrap_fence.js")
   recorded=json.loads((service/"dist/.source-digest.json").read_text())
   expect(recorded["schema_version"]==1 and recorded["digest"].startswith("sha256:") and recorded["files"]>3,"stamp malformed: "+json.dumps(recorded))
  check("build-records-digest",build)

  def fresh_passes():
   r=stamp("check",service);expect(r.returncode==0 and json.loads(r.stdout)["fresh"],"fresh build refused: "+r.stdout+r.stderr)
  check("fresh-check-passes",fresh_passes)

  def installer_passes_fresh():
   if not as_root:return "SKIP: installer requires the root operator"
   code=install(base,inputs)
   expect(code not in ("INSTALL_STALE_DIST","INSTALL_UNSTAMPED_DIST","INSTALL_ROOT_OPERATOR_REQUIRED","INSTALL_ARGUMENTS"),"fresh dist refused at the gate: "+code)
   return "observed: gate passed, later refusal "+code
  check("installer-accepts-fresh",installer_passes_fresh)

  target=service/"src/recovery/bootstrap_fence.ts";original=target.read_bytes()
  def tampered_refused():
   target.write_bytes(original+b"\n// tampered after build\n")
   try:
    r=stamp("check",service);out=json.loads(r.stdout)
    expect(r.returncode==1 and out["code"]=="DIST_STALE","tampered source accepted: "+r.stdout)
    if as_root:expect(install(base,inputs)=="INSTALL_STALE_DIST","installer did not refuse a stale dist")
   finally:target.write_bytes(original)
  check("tampered-source-refused",tampered_refused)

  def added_source_refused():
   extra=service/"src/unbuilt.ts";extra.write_text("export const unbuilt=1;\n")
   try:
    r=stamp("check",service);expect(r.returncode==1 and json.loads(r.stdout)["code"]=="DIST_STALE","unbuilt source file accepted")
   finally:extra.unlink()
  check("added-source-refused",added_source_refused)

  def restored_passes():
   r=stamp("check",service);expect(r.returncode==0,"restored source still refused: "+r.stdout)
  check("restored-source-passes",restored_passes)

  def unstamped_refused():
   s=service/"dist/.source-digest.json";saved=s.read_bytes();s.unlink()
   try:
    r=stamp("check",service);expect(r.returncode==1 and json.loads(r.stdout)["code"]=="DIST_UNSTAMPED","unstamped dist accepted")
    if as_root:expect(install(base,inputs)=="INSTALL_UNSTAMPED_DIST","installer did not refuse an unstamped dist")
   finally:s.write_bytes(saved)
  check("unstamped-dist-refused",unstamped_refused)

  def release_gates_build():
   text=(ROOT/"tools/repository/release.sh").read_text()
   build_at=text.index("subprocess.run(['npm','run','build'],cwd=build,check=True)")
   gate_at=text.index("str(stamp_tool),'check',str(build)")
   stage_at=text.index("shutil.copytree(build/'dist',stage/'services/dist')")
   expect(build_at<gate_at<stage_at,"release.sh does not gate the shipped dist between build and staging")
   expect("build=temp/'core/control-plane'" in text and "temp/'deploy/hyperfide/dist-stamp.mjs'" in text,"release build tree does not mirror the checkout layout this case exercises")
  check("release-gates-shipped-dist",release_gates_build)

 print(json.dumps({"type":"summary","assertions":len(IDS),"failed":FAILED,"skipped":SKIPPED}),flush=True)
 return 1 if FAILED else 0

if __name__=="__main__":sys.exit(main())
