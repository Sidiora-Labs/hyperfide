"""Exact raw-spec status derivation; live source files are read only."""
import copy,json,sys,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4];sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
import fleet_live_qualification as oracle

def changed_status(body,task,value):
 lines=body.splitlines(keepends=True);start=lines.index(('[task.'+task+']\n').encode())
 for n in range(start+1,len(lines)):
  if lines[n].startswith(b'['):break
  if lines[n].startswith(b'status = '):lines[n]=('status = "'+value+'"'+('\n' if lines[n].endswith(b'\n') else '')).encode();return b''.join(lines)
 raise AssertionError('Actual task status missing')
def main():
 source=(ROOT/'spec/hyperfide-source-control/spec.kvx').read_bytes();baseline=source;tasks=['0.10','0.11','0.12','0.13','0.14']
 for task in tasks:baseline=changed_status(baseline,task,'in_progress')
 path='spec/hyperfide-source-control/spec.kvx';pin={'path':path,'digest':oracle.digest(baseline)}
 with tempfile.TemporaryDirectory(prefix='hf-status-derivation-') as directory:
  root=Path(directory);archive=root/'baseline.kvx';archive.write_bytes(baseline);archive.chmod(0o600)
  declaration={'schema_version':1,'path':path,'baseline':{'path':archive.name,'digest':pin['digest']},'allowed_transitions':[{'task':t,'from':'in_progress','to':'done'} for t in tasks]};target_before=oracle.digest(declaration);current=baseline
  for count in range(6):
   if count:current=changed_status(current,tasks[count-1],'done')
   result=oracle.verified_contract_status_derivation(declaration,pin,current,root);assert [t['task'] for t in result['transitions']]==tasks[:count] and result['baseline_digest']==pin['digest'] and result['current_digest']==oracle.digest(current) and oracle.digest(declaration)==target_before
  negatives=['changed-requirement','other-task-status','wrong-path','snapshot-tamper','archive-pin-tamper','out-of-order','different-transition','status-trailing-comment','archive-path-escape']
  for name in negatives:
   policy=copy.deepcopy(declaration);body=baseline;archive.write_bytes(baseline)
   if name=='changed-requirement':n=body.index(b'[req.');body=body[:n+1]+b'X'+body[n+2:]
   elif name=='other-task-status':body=changed_status(body,'0.1','done')
   elif name=='wrong-path':policy['path']='contracts/fleet/index.mjs'
   elif name=='snapshot-tamper':archive.write_bytes(baseline+b'\n')
   elif name=='archive-pin-tamper':policy['baseline']['digest']=oracle.digest(b'changed archive')
   elif name=='out-of-order':body=changed_status(body,'0.11','done')
   elif name=='different-transition':policy['allowed_transitions'][0]['to']='implemented'
   elif name=='status-trailing-comment':
    before,section=changed_status(body,'0.10','done').split(b'[task.0.10]\n',1);body=before+b'[task.0.10]\n'+section.replace(b'status = "done"\n',b'status = "done" # changed\n',1)
   else:policy['baseline']['path']='../baseline.kvx'
   try:oracle.verified_contract_status_derivation(policy,pin,body,root)
   except oracle.Refused:pass
   else:raise AssertionError('Status derivation admitted '+name)
 print(json.dumps({'status':'PASS','scope':'controlled baseline task statuses in a private rawspec copy; six allowed ordered prefixes, nine unauthorized derivation refusals; source unchanged','source_digest':oracle.digest(source),'baseline_digest':pin['digest'],'negative_cases':negatives}));return 0
if __name__=='__main__':raise SystemExit(main())
