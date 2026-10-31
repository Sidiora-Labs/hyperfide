#!/usr/bin/env python3
from pathlib import Path
import sys,json,os,subprocess,time
ROOT=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT/"tests/hyperfide/support"))
from identity_fixture import IdentityFixture,RESULTS,check,expect,uid,sha

def main():
    canary="private-materialization-"+uid()
    expiry=time.strftime("%Y-%m-%dT%H:%M:%S.000Z",time.gmtime(time.time()+1800))
    stores=[]
    def setup(f):
        for index in range(2):
            root=f.path/("store-"+str(index));root.mkdir(mode=0o700)
            attachments=f.path/("attachments-"+str(index));attachments.mkdir(mode=0o700)
            source=root/"token";source.write_text(canary);source.chmod(0o600)
            config={"schema_version":1,"secret_root":str(root),"attachment_root":str(attachments),"sources":[{"name":"token","relative_path":"token","expires_at":expiry,"purposes":["WORKER_PROCESS"],"materialize_current_version":index==1}],"targets":[]}
            file=f.path/("credentials-"+str(index)+".json");file.write_text(json.dumps(config));file.chmod(0o600);stores.append((root,file))
        f.env["HF_CREDENTIAL_CONFIG_FILE"]=str(stores[0][1])
    f=IdentityFixture(extra_components=["14.2"],extra_setup=setup)
    try:
        def private_resolve(request):
            from identity_fixture import canonical,b64
            body=f.operation("14.2","credentials.inspect",{"reference_id":"inference/account"});raw=canonical(body);seconds=str(int(time.time()));nonce=uid()
            signature=f.sign("operator",("\n".join(("HYPERFIDE-REQUEST-V1","POST","/v1/invoke",f.origin,f.ids["operator"],seconds,nonce,sha(raw),""))).encode())
            args={"components":str(f.components),"policy":str(f.policy),"body":b64(raw),"headers":["HF-Credential-Id",f.ids["operator"],"HF-Request-Time",seconds,"HF-Request-Nonce",nonce,"HF-Request-Signature",signature],"request":request,"expected":sha(canary.encode())}
            script="""import fs from 'node:fs';import {ComponentRegistry} from './core/control-plane/dist/components/registry.js';import {validatePolicy} from './core/control-plane/dist/policy/programme.js';import {hash} from './core/control-plane/dist/transport/protocol.js';const a=JSON.parse(fs.readFileSync(0,'utf8')),c=new AbortController(),policy=validatePolicy(JSON.parse(fs.readFileSync(a.policy,'utf8')),'fixture-identity-v1','control'),r=new ComponentRegistry({role:'control',env:process.env,signal:c.signal,policy});try{await r.load(a.components,process.cwd()+'/core/control-plane/dist');const auth=r.resolveCapability('14.1','identity.authority',v=>typeof v.authenticate==='function'),i=await auth.authenticate(Buffer.from(a.body,'base64url'),a.headers,c.signal),credentials=r.resolveCapability('14.2','identity.credentials',v=>typeof v.resolveCredentialReferences==='function');const values=await credentials.resolveCredentialReferences(i,a.request,c.signal);process.stdout.write(JSON.stringify({ok:true,matched:hash(values.TOKEN)===a.expected,count:Object.keys(values).length}));}catch(e){process.stdout.write(JSON.stringify({ok:false,code:e.code??'ERROR'}));}finally{await r.close();}"""
            result=subprocess.run(["node","--input-type=module","-e",script],input=json.dumps(args),cwd=ROOT,env=f.env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=20)
            expect(result.returncode==0,"private actual capability process failed: "+result.stderr[:200]);return json.loads(result.stdout)
        base={"reference_id":"inference/account","source_name":"token","expected_version":"0","expires_at":expiry,"allowed_layers":["process"],"allowed_roles":["OPERATOR"],"refresh_owner":f.ids["operator"],"purposes":["WORKER_PROCESS"]}
        rotated=f.invoke("credentials.reference.rotate",base,component="14.2")[1]
        expect(rotated.get("result",{}).get("credential_version")=="1","actual rotation failed")
        row=f.sql("SELECT secret_locator,source_name,secret_digest,credential_version FROM hyperfide.identity_credential_references WHERE reference_id='inference/account'")[0]
        expect(row["source_name"]=="token" and row["secret_digest"]==sha(canary.encode()),"rotation did not bind actual source bytes")
        expect(f.bind()[1].get("ok") is True,"actual provider binding failed")
        request={"references":[{"name":"TOKEN","reference_id":"inference/account"}],"purpose":"WORKER_PROCESS","sandbox_id":f.ids["sandbox"],"boot_id":f.ids["boot"],"boot_generation":"1","expected_versions":{"TOKEN":"1"}}
        f.env["HF_CREDENTIAL_CONFIG_FILE"]=str(stores[1][1])
        destination=stores[1][0]/row["secret_locator"]
        check("credentials.replica.current-source-materializes",lambda:expect(private_resolve(request)=={"ok":True,"matched":True,"count":1},"second private store failed resolution"))
        info=destination.lstat()
        check("credentials.replica.exact-private-bytes",lambda:expect(sha(destination.read_bytes())==sha(canary.encode()) and info.st_uid==os.getuid() and info.st_mode&0o777==0o600 and info.st_nlink==1,"materialized file identity differs"))
        destination.unlink()
        check("credentials.replica.stale-version-refuses",lambda:expect(private_resolve({**request,"expected_versions":{"TOKEN":"2"}}).get("code")=="VERSION_CONFLICT" and not destination.exists(),"stale admitted version materialized"))
        source=stores[1][0]/"token";source.write_text("different-private-source")
        check("credentials.replica.source-byte-mismatch-refuses",lambda:expect(private_resolve(request).get("ok") is False and not destination.exists(),"different source bytes materialized"))
        source.write_text(canary)
        config=json.loads(stores[1][1].read_text());config["sources"][0]["materialize_current_version"]=False;stores[1][1].write_text(json.dumps(config))
        check("credentials.replica.opt-in-required",lambda:expect(private_resolve(request).get("ok") is False and not destination.exists(),"untrusted recovery accepted"))
        config["sources"][0]["materialize_current_version"]=True;stores[1][1].write_text(json.dumps(config))
        f.sql("UPDATE hyperfide.identity_credential_references SET source_name=NULL,secret_digest=NULL WHERE reference_id='inference/account'")
        check("credentials.replica.legacy-missing-refuses",lambda:expect(private_resolve(request).get("ok") is False and not destination.exists(),"unbound legacy credential materialized"))
    finally:f.close()
    return int(any(actual!="observed" for _,actual in RESULTS))
if __name__=="__main__":raise SystemExit(main())
