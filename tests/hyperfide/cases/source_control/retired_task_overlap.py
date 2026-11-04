#!/usr/bin/env python3
"""Admit a replacement owner while preserving an explicitly retired task."""
import copy,importlib.util,json,os,subprocess,sys,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
import identity_fixture
spec=importlib.util.spec_from_file_location('amendment_fixture',ROOT/'tests/hyperfide/cases/tasks/2_3.py');base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)


def main():
    if not os.environ.get('DATABASE_URL'):
        return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,__file__],cwd=ROOT).returncode
    if os.environ.get('HF_RETIRED_PLAN_ROOT'):
        identity_fixture.ROOT=Path(os.environ['HF_RETIRED_PLAN_ROOT']).resolve()
    f=identity_fixture.IdentityFixture(extra_components=base.components(),extra_setup=base.setup)
    try:
        i=f.ids;scope=[i['organisation'],i['run']]
        for name,clause,acceptance in [('task1','1.1','1'),('task2','1.1','1'),('task3','2.1','2')]:
            base.success(f,'spec.proof.register',{'run_id':i['run'],'task_id':i[name],'spec_revision_id':i['accepted_spec'],'spec_generation':'2','state_version':'2','policy':base.policy(f,name,f.criteria,i['accepted_spec'],'2',clause,acceptance)},component='spec-obligations')
        assert base.success(f,'spec.dependencies.admit',{'run_id':i['run'],'spec_revision_id':i['accepted_spec'],'spec_generation':'2','state_version':'2'},component='spec-dependencies')['admitted'] is True
        f.sql("UPDATE hyperfide.runs SET state='RUNNING',state_version=state_version+1 WHERE organisation_id=$1 AND id=$2",scope)
        old=base.task_row(f,'task3')
        replacement=base.SOURCE[:base.SOURCE.index('[task.3]')]+'''[task.4]
wave = 1
feature = "replacement"
reqs = ["2.1"]
verify_cmd = "printf independent"
artifacts = ["proof.json"]
acceptance_ids = ["2"]
requires = []
touches = ["src/c.ts"]
'''
        proposal=base.success(f,'spec.amendment.propose',base.request(f,replacement))
        assert proposal['decision']=='PROPOSED' and proposal['impact']['retired']==['3'] and proposal['impact']['added']==['4'],proposal
        generation=str(int(base.run_row(f)['g'])+1)
        revision_digest=f.sql("SELECT proposal->>'revision_digest' AS digest FROM hyperfide.spec_amendments WHERE id=$1",[proposal['amendment_id']])[0]['digest']
        revision=base.derived(i['organisation']+':'+i['project']+':'+revision_digest)
        criteria=base.sha(json.dumps({'reqs':['2.1'],'source_digest':base.sha(base.proof_source(replacement).encode())},separators=(',',':')).encode())
        proofs=[{'task_key':'4','policy':base.policy(f,'4',criteria,revision,generation,'2.1','2')}]
        status,response=f.invoke('spec.amendment.admit',base.admit(f,proposal,[i['task3']],proofs),component='spec-revisions')
        assert response.get('ok') is True,{'http_status':status,'error':response.get('error')}
        admitted=response['result']
        assert admitted['decision']=='ACCEPTED' and base.run_row(f)['g']==generation
        retired=base.task_row(f,'task3');assert retired['state']=='CANCELLED' and retired['definition']['retirement']['amendment_id']==proposal['amendment_id']
        retired_section=copy.deepcopy(old['definition']['section']);retired_section['fields'].pop('requires',None)
        assert retired['definition']['section']==retired_section
        active=f.sql("SELECT id,state,definition,feature_package_id FROM hyperfide.tasks WHERE organisation_id=$1 AND run_id=$2 AND task_key='4'",scope)[0]
        assert active['state']=='PENDING' and active['definition']['feature_key']=='replacement'
        history=f.sql("SELECT spec_generation::text AS generation,definition FROM hyperfide.task_revisions WHERE organisation_id=$1 AND run_id=$2 AND task_id=$3 ORDER BY spec_generation",[*scope,i['task3']])
        assert history and history[0]['definition']['section']==old['definition']['section']
        report_request={'run_id':i['run'],'spec_revision_id':revision,'spec_generation':generation,'state_version':base.run_row(f)['v']}
        report=base.success(f,'spec.dependencies.check',report_request,component='spec-dependencies');assert report['status']=='STRUCTURALLY_VALID',report
        shadow=str(uuid.uuid4());definition=copy.deepcopy(old['definition']);definition['section']['name']='task.shadow';definition['section']['fields']['feature']['value']='fixture';assert 'retirement' not in definition
        f.sql("INSERT INTO hyperfide.tasks(organisation_id,run_id,id,task_key,feature_package_id,spec_revision_id,spec_generation,criteria_digest,definition,wave,state) VALUES($1,$2,$3,'shadow',$4,$5,$6,$7,$8,1,'PENDING')",[*scope,shadow,i['package'],revision,generation,f.criteria,json.dumps(definition)])
        for state in ['PENDING','CANCELLED']:
            f.sql('UPDATE hyperfide.tasks SET state=$4,state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[*scope,shadow,state])
            report=base.success(f,'spec.dependencies.check',report_request,component='spec-dependencies')
            conflicts=[x for x in report['diagnostics'] if x['code']=='SCOPE_OWNERSHIP_CONFLICT' and x.get('scope_path')=='src/c.ts']
            assert report['status']=='INVALID' and conflicts,(state,report)
        preserved=base.task_row(f,'task3');assert preserved==retired
        print(json.dumps({'status':'PASS','checks':['signed replacement admission after explicit retirement','retired definition and revision history retained','active competing owner refused','cancelled owner without retirement remains conflicting'],'generation':generation}))
        return 0
    finally:
        f.close()


if __name__=='__main__':raise SystemExit(main())
