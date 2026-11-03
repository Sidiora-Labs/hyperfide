#!/usr/bin/env python3
"""Validate the packaged native source release and explicit operator acceptance."""
import argparse
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import uuid

ROOT=Path(__file__).resolve().parents[4]
spec=importlib.util.spec_from_file_location('release_source_closure',ROOT/'tests/hyperfide/source-control/closure.py')
closure=importlib.util.module_from_spec(spec);spec.loader.exec_module(closure)
ROLES={'service','host','native','cli','sdk'}

def pin(base, record):
    closure.require(isinstance(record,dict) and set(record)=={'path','sha256','size'},'Exact artifact content pin required')
    path=closure.path_from(base,record['path'])
    closure.require(path.is_file() and not path.is_symlink(),'Release artifact missing or symbolic')
    closure.require(type(record['size']) is int and record['size']>=0 and path.stat().st_size==record['size'],'Release artifact size differs')
    closure.require(record['sha256']==closure.digest(path),'Release artifact checksum differs')
    return path

def verify_inputs(manifest_path, manifest):
    closure.require(set(manifest)=={'schema_version','release_id','source','source_format_version','protocol_version','closure_packet','artifacts','operator_acceptance'},'Release manifest fields differ from version 1')
    closure.require(all(type(manifest[key]) is int and manifest[key]==1 for key in ['schema_version','source_format_version','protocol_version']),'Unsupported release source format or protocol')
    closure.require(str(uuid.UUID(manifest['release_id']))==manifest['release_id'],'Canonical release identity required')
    source=closure.source_identity(manifest['source'])
    base=Path(manifest_path).resolve().parent
    artifacts=manifest['artifacts']
    closure.require(isinstance(artifacts,list) and artifacts,'Packaged release artifacts required')
    covered=set(); paths=set()
    for artifact in artifacts:
        closure.require(isinstance(artifact,dict) and set(artifact)=={'roles','path','sha256','size'},'Release artifact roles and pin required')
        roles=artifact['roles']
        closure.require(isinstance(roles,list) and roles and len(set(roles))==len(roles) and set(roles)<=ROLES,'Release artifact roles are invalid')
        path=pin(base,{key:artifact[key] for key in ('path','sha256','size')})
        closure.require(path.resolve() not in paths,'Duplicate release artifact')
        paths.add(path.resolve());covered.update(roles)
    closure.require(covered==ROLES,'Missing packaged roles: '+', '.join(sorted(ROLES-covered)))
    packet=pin(base,manifest['closure_packet'])
    acceptance_file=pin(base,manifest['operator_acceptance'])
    acceptance=closure.load(acceptance_file)
    closure.require(set(acceptance)=={'schema_version','release_id','accepted','accepted_by','accepted_at','source_revision_id','closure_packet_sha256'},'Exact operator acceptance record required')
    closure.require(type(acceptance['schema_version']) is int and acceptance['schema_version']==1 and acceptance['accepted'] is True,'Explicit operator acceptance is required')
    closure.require(acceptance['release_id']==manifest['release_id'] and acceptance['source_revision_id']==source['revision_id'] and acceptance['closure_packet_sha256']==manifest['closure_packet']['sha256'],'Operator acceptance does not bind this release')
    closure.require(isinstance(acceptance['accepted_by'],str) and bool(acceptance['accepted_by'].strip()),'Operator acceptance identity required')
    stamp=acceptance['accepted_at']
    closure.require(isinstance(stamp,str) and stamp.endswith('Z'),'Operator acceptance must use UTC time')
    observed=dt.datetime.fromisoformat(stamp.replace('Z','+00:00'))
    closure.require(observed<=dt.datetime.now(dt.timezone.utc)+dt.timedelta(minutes=5),'Operator acceptance cannot be future dated')
    return packet

def verify_release(manifest_path):
    manifest=closure.load(manifest_path)
    packet=verify_inputs(manifest_path,manifest)
    report=closure.verify_packet(packet)
    closure.require(report['release_id']==manifest['release_id'] and report['source']==manifest['source'],'Qualified packet does not bind this release')
    return {'schema_version':1,'status':'PASS','release_id':report['release_id'],'source':report['source'],'manifest_sha256':closure.digest(manifest_path),'closure_packet_sha256':report['packet_sha256'],'verified_case_variants':len(report['checked_evidence']),'operator_acceptance':manifest['operator_acceptance']['sha256']}

def self_test():
    checks=[]
    with tempfile.TemporaryDirectory(prefix='hf-source-release-') as temporary:
        root=Path(temporary);artifact=root/'runtime.tar';artifact.write_bytes(b'owned release artifact')
        packet=root/'packet.json';packet.write_bytes(b'{}')
        source={'scope':{key:str(uuid.uuid4()) for key in ['organisation_id','repository_id','security_domain_id']},'revision_id':'sha256:'+'a'*64,'root_tree_id':'sha256:'+'b'*64,'authority_epoch':str(uuid.uuid4()),'policy_version':'release-check'}
        def content(path):return {'path':path.name,'sha256':closure.digest(path),'size':path.stat().st_size}
        release_id=str(uuid.uuid4());acceptance=root/'acceptance.json'
        acceptance_value={'schema_version':1,'release_id':release_id,'accepted':True,'accepted_by':'declared-test-operator','accepted_at':dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00','Z'),'source_revision_id':source['revision_id'],'closure_packet_sha256':closure.digest(packet)}
        acceptance.write_bytes(closure.canonical(acceptance_value))
        manifest={'schema_version':1,'release_id':release_id,'source':source,'source_format_version':1,'protocol_version':1,'closure_packet':content(packet),'artifacts':[dict(content(artifact),roles=sorted(ROLES))],'operator_acceptance':content(acceptance)}
        target=root/'release.json';target.write_bytes(closure.canonical(manifest))
        if verify_inputs(target,manifest)!=packet:raise AssertionError('Artifact validation did not preserve packet')
        checks.append('artifact-pins-and-acceptance-binding')
        def refused(name, value, expected):
            try:verify_inputs(target,value)
            except closure.ClosureError as error:
                if expected not in str(error):raise AssertionError((name,str(error)))
                checks.append(name)
            else:raise AssertionError(name+' passed unexpectedly')
        import copy
        bad=copy.deepcopy(manifest);bad['artifacts'][0]['sha256']='0'*64;refused('artifact-tamper',bad,'checksum')
        bad=copy.deepcopy(manifest);bad['artifacts'][0]['roles']=['native'];refused('missing-runtime-roles',bad,'Missing packaged')
        bad=copy.deepcopy(manifest);bad['source_format_version']=2;refused('unsupported-source-format',bad,'Unsupported')
        bad=copy.deepcopy(manifest);bad['source']['revision_id']='sha256:'+'c'*64;refused('acceptance-other-source',bad,'does not bind')
        acceptance_value['accepted']=False;acceptance.write_bytes(closure.canonical(acceptance_value));bad=copy.deepcopy(manifest);bad['operator_acceptance']=content(acceptance);refused('operator-refusal',bad,'Explicit operator')
    return {'schema_version':1,'status':'PASS','scope':'release input validation; complete canonical evidence required separately','checks':checks}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest',default=os.environ.get('HF_SOURCE_RELEASE_MANIFEST'))
    parser.add_argument('--self-test',action='store_true')
    args=parser.parse_args()
    try:
        if args.self_test:
            report=self_test()
            for name in report['checks']:
                print(json.dumps({'type':'assertion','id':'source-release.'+name,'expected':True,'actual':True}))
            print(json.dumps({'type':'cleanup','complete':True,'resources':[]}))
        else:
            if not args.manifest:raise closure.ClosureError('HF_SOURCE_RELEASE_MANIFEST or --manifest must identify the qualified release and operator acceptance')
            report=verify_release(args.manifest)
        if args.self_test:
            directory=ROOT/'build/source-control/7.2';directory.mkdir(parents=True,exist_ok=True)
            (directory/'receipt.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report,sort_keys=True));return 0
    except (closure.ClosureError,OSError,ValueError,TypeError,KeyError) as error:
        print(json.dumps({'schema_version':1,'status':'BLOCKED','diagnostics':[str(error)]}));return 2

if __name__=='__main__':raise SystemExit(main())
